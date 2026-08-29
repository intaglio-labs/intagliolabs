#!/bin/sh
# Build libolm.3.dylib, the one thing the native bridges need that upstream does
# not ship.
#
#   bash ops/build-libolm.sh [outdir]     # default: ~/.hazlie/bridges/bin
#
# WHY THIS EXISTS. Every mautrix bridge binary carries LC_LOAD_DYLIB on
# @rpath/libolm.3.dylib -- a HARD link, not a weak one, so the process aborts in
# dyld before main() if it is absent. mautrix's macOS CI builds that dylib and
# keeps it as a CI artifact; the GitHub release assets carry only the binaries
# and sha256sums.txt. Their rpath is @executable_path first, so the dylib goes
# beside the binary and nothing needs to be installed system-wide.
#
# WHERE IT COMES FROM, and this is worth reading before depending on it:
# libolm is ARCHIVED. matrix.org deprecated it in favour of vodozemac, the
# GitHub mirror is an empty 7 KB stub, and Homebrew no longer carries a formula
# (formulae.brew.sh returns nothing for it). The only real source is
# gitlab.matrix.org, whose newest tag is 3.2.16 -- which is exactly the version
# the bridges link (otool reports current version 3.2.16), so this is not a
# guess about compatibility.
#
# IT DOES NOT COMPILE UNPATCHED, on two counts, both handled below:
#
#   1. cmake_minimum_required predates 3.5 and CMake 4 removed that
#      compatibility. -DCMAKE_POLICY_VERSION_MINIMUM=3.5 is CMake's own
#      suggested remedy, printed in its error.
#
#   2. include/olm/list.hh's List::operator= does not compile under a current
#      clang. It declares `T * const other_pos` and then increments it, and
#      assigns `*this_pos = *other` where `other` is a List reference rather
#      than a pointer. BOTH are wrong, and the function is DEAD CODE: nothing in
#      libolm instantiates it, which is the only reason this ever shipped.
#      Older clang deferred the diagnosis to instantiation; newer clang catches
#      the non-dependent part at definition time. The patch makes it say what it
#      plainly meant -- walk the source, copy each element -- and because the
#      function is never called it cannot change behaviour. It touches a list
#      container, not a crypto primitive. That distinction is the whole reason
#      this patch is acceptable and a larger one would not be.
#
# THE STRATEGIC NOTE, so nobody discovers it later: this pins a consumer app's
# social bridges to a patched build of an abandoned crypto library. It works, it
# is Apache-2.0, and it is a liability rather than a destination. The better end
# state is bridges that do not link libolm at all -- mautrix-go carries a pure-Go
# implementation (goolm) -- which would delete this file. Until someone has
# tested that, this is the honest way to run.

set -eu
OUT="${1:-$HOME/.hazlie/bridges/bin}"
VERSION="3.2.16"
SRC_URL="https://gitlab.matrix.org/matrix-org/olm/-/archive/${VERSION}/olm-${VERSION}.tar.gz"

for tool in cmake curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "missing required tool: $tool" >&2; exit 1; }
done

WORK=$(mktemp -d "${TMPDIR:-/tmp}/libolm.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "fetching libolm ${VERSION}"
curl -fsSL -o src.tar.gz "$SRC_URL"
tar xzf src.tar.gz
cd "olm-${VERSION}"

# See note 2 above. Applied with a here-doc rather than a patch file so the
# reason travels with the change; if upstream ever moves, this fails loudly
# rather than silently building something else.
python3 - <<'PATCH'
import io, sys
p = 'include/olm/list.hh'
s = io.open(p, encoding='utf-8').read()
old = """        T * this_pos = _data;
        T * const other_pos = other._data;
        while (other_pos != other._end) {
            *this_pos = *other;
            ++this_pos;
            ++other_pos;
        }"""
new = """        T * this_pos = _data;
        T const * other_pos = other._data;
        while (other_pos != other._end) {
            *this_pos = *other_pos;
            ++this_pos;
            ++other_pos;
        }"""
if s.count(old) != 1:
    sys.stderr.write(
        'libolm list.hh does not look as expected -- the const-pointer bug this '
        'patch fixes is absent or changed. Re-read it before building.\n')
    sys.exit(1)
io.open(p, 'w', encoding='utf-8').write(s.replace(old, new, 1))
print('patched include/olm/list.hh (dead List::operator=)')
PATCH

cmake -S . -B build \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DCMAKE_OSX_ARCHITECTURES=arm64 \
  -DBUILD_SHARED_LIBS=ON \
  -DOLM_TESTS=OFF >/dev/null 2>&1
# Quiet on success, loud on failure. The vendored doctest header and the archived
# CMakeLists between them emit hundreds of deprecation warnings that are not
# actionable here and bury the one line that matters.
if ! cmake --build build -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" >build.log 2>&1; then
  echo "libolm build failed:" >&2
  tail -30 build.log >&2
  exit 1
fi

[ -f build/libolm.3.dylib ] || { echo "build produced no libolm.3.dylib" >&2; exit 1; }

mkdir -p "$OUT"
cp build/libolm.3.dylib "$OUT/libolm.3.dylib"
chmod 0755 "$OUT/libolm.3.dylib"

# Ad-hoc sign it. An unsigned Mach-O does not load on Apple Silicon, and a dylib
# that fails to load takes the bridge with it before main(). Release builds
# re-sign the whole bundle with the Developer ID identity anyway; this is what
# makes a local build runnable.
codesign --force --sign - "$OUT/libolm.3.dylib" 2>/dev/null || true

echo "libolm ${VERSION} -> $OUT/libolm.3.dylib"
