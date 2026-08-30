#!/usr/bin/env python3
# Make a copy of Homebrew's llama-server + every non-system dylib it needs
# (recursively), with all install names rewritten to @rpath/<name> and an rpath
# of @loader_path/../lib on the binary. Usage: bundle-llama.py <destdir>
#
# IT IS NOT PORTABLE, AND THIS COMMENT USED TO SAY IT WAS. The claim was
# "Verified to keep Metal GPU inference working (the Metal backend is embedded
# in libggml)". That was true of the llama.cpp of the day and is not true of
# Homebrew's build now: ggml splits its backends into separately dlopen'd
# modules, Homebrew ships them as <ggml-cellar>/libexec/libggml-{metal,cpu-*,
# blas}.so, and libggml has that ABSOLUTE Cellar path compiled in as the only
# place it looks.
#
# Two consequences, both measured 2026-08-30:
#
#   1. A bundled runtime finds no backends on any Mac without that exact
#      Homebrew ggml version. Reproduced with `sandbox-exec` denying reads under
#      /opt/homebrew/Cellar/ggml: the freshly-staged bundle fails with "no
#      backends are loaded", which is the same error the owner's llama-server
#      agent had been crash-looping on.
#   2. It breaks on the BUILD machine too, on the next `brew upgrade`. The
#      owner's runtime was ggml 0.21.0 pointing at .../ggml/0.21.0/libexec;
#      Homebrew moved to 0.22.0 and deleted that directory underneath it.
#
# Things that do NOT work, so nobody re-tries them: putting the .so files beside
# the executable or beside the dylibs (ggml makes zero load attempts -- it does
# not search either), and GGML_BACKEND_PATH (it dlopens the one literal path it
# is given, takes no separator, and one backend is not enough -- Metal alone
# then fails with "make_cpu_buft_list: no CPU backend found").
#
# The real fix is to stop consuming Homebrew's dynamic-backend build: either
# compile llama.cpp with -DGGML_BACKEND_DL=OFF so Metal and CPU are linked into
# libggml as this comment once assumed, or ship llama.cpp's own release
# binaries. Both are build-pipeline decisions, so this script reports the
# problem loudly rather than pretending to have solved it.
import subprocess, os, re, shutil, sys

dest = sys.argv[1]
os.makedirs(dest + '/bin', exist_ok=True)
os.makedirs(dest + '/lib', exist_ok=True)
SRC = shutil.which('llama-server') or '/opt/homebrew/bin/llama-server'


def deps(b):
    out = subprocess.run(['otool', '-L', b], capture_output=True, text=True).stdout.splitlines()[1:]
    return [l.split()[0] for l in out if l.strip()]


def rpaths(b):
    out = subprocess.run(['otool', '-l', b], capture_output=True, text=True).stdout
    return re.findall(r'path (\S+) \(offset', out)


def resolve(ref, origin):
    if ref.startswith('@rpath/'):
        for rp in rpaths(origin):
            c = rp.replace('@loader_path', os.path.dirname(origin)) + '/' + ref[7:]
            if os.path.exists(c):
                return os.path.realpath(c)
        for base in ['/opt/homebrew/lib', '/opt/homebrew/opt/ggml/lib']:
            c = base + '/' + ref[7:]
            if os.path.exists(c):
                return os.path.realpath(c)
    elif ref.startswith('/') and os.path.exists(ref):
        return os.path.realpath(ref)
    return None


# Recursive collection of every non-system dependency.
seen, queue, libs = set(), [SRC], set()
while queue:
    b = queue.pop()
    if b in seen:
        continue
    seen.add(b)
    for d in deps(b):
        if d.startswith('/usr/lib') or d.startswith('/System/'):
            continue
        r = resolve(d, b)
        if r:
            libs.add(r)
            if r not in seen:
                queue.append(r)

shutil.copy2(SRC, dest + '/bin/llama-server')
libset = {os.path.realpath(x) for x in libs}
for l in libs:
    shutil.copy2(os.path.realpath(l), dest + '/lib/' + os.path.basename(os.path.realpath(l)))


def rewrite(path, is_bin):
    for orig in deps(path):
        if orig.startswith('/usr/lib') or orig.startswith('/System/'):
            continue
        r = resolve(orig, path)
        if r and os.path.realpath(r) in libset:
            subprocess.run(['install_name_tool', '-change', orig,
                            '@rpath/' + os.path.basename(os.path.realpath(r)), path])
    if not is_bin:
        subprocess.run(['install_name_tool', '-id', '@rpath/' + os.path.basename(path), path])
    rp = '@loader_path/../lib' if is_bin else '@loader_path'
    subprocess.run(['install_name_tool', '-add_rpath', rp, path], capture_output=True)


rewrite(dest + '/bin/llama-server', True)
for l in os.listdir(dest + '/lib'):
    rewrite(dest + '/lib/' + l, False)
os.chmod(dest + '/bin/llama-server', 0o755)
print(f'bundled llama-server + {len(libset)} dylibs -> {dest}')

# THE PORTABILITY CHECK THIS SCRIPT SHOULD ALWAYS HAVE HAD. Look for the
# compiled-in Cellar backend directory and say so. A silent pass here shipped a
# local-answering feature that cannot start on any machine but the builder's.
import glob
cellar = set()
for lib in glob.glob(dest + '/lib/*.dylib'):
    with open(lib, 'rb') as fh:
        for m in re.findall(rb'/opt/homebrew/Cellar/ggml/[0-9.]+/libexec', fh.read()):
            cellar.add(m.decode())
if cellar:
    print()
    print('  WARNING: this llama runtime is NOT portable.', file=sys.stderr)
    for c in sorted(cellar):
        print(f'    libggml looks for its backends in {c}', file=sys.stderr)
    print('    That path exists only on a machine with this exact Homebrew ggml.',
          file=sys.stderr)
    print('    Everywhere else llama-server exits with "no backends are loaded".',
          file=sys.stderr)
    print('    See the header of this file for what was tried and what is left.',
          file=sys.stderr)
