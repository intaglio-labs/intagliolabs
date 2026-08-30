#!/usr/bin/env python3
# Stage llama.cpp's OWN macOS release into the app bundle, flat, verified by
# sha256. Usage: bundle-llama.py <destdir>  (writes <destdir>/bin)
#
# THIS USED TO REPACKAGE HOMEBREW'S BUILD, AND THAT COULD NOT WORK.
#
# It copied llama-server plus every non-system dylib reachable through
# `otool -L`, rewrote install names to @rpath, and called the result portable.
# Its header said Metal kept working because "the Metal backend is embedded in
# libggml". That was true of the llama.cpp of the day and stopped being true:
# ggml now splits its backends into separately dlopen'd modules, and a dlopen'd
# module is nobody's link dependency, so the recursive walk collected none of
# them. Worse, Homebrew compiles an ABSOLUTE path to its own Cellar --
# /opt/homebrew/Cellar/ggml/<version>/libexec -- into libggml as the only place
# it looks for them.
#
# Both halves were measured on 2026-08-30:
#
#   The shipped app could never run local answering on a user's Mac. Reproduced
#   with `sandbox-exec` denying reads under /opt/homebrew/Cellar/ggml: a freshly
#   staged bundle dies with "no backends are loaded", the exact error the
#   owner's llama-server agent had been crash-looping on.
#
#   It broke on the BUILD machine too, at the next `brew upgrade`. The owner's
#   runtime was ggml 0.21.0 pointing at .../ggml/0.21.0/libexec; Homebrew moved
#   to 0.22.0 and deleted that directory underneath it. That is what took the
#   agent down, and the top-line error -- "failed to load model, model.gguf" --
#   pointed at a model file that was never the problem.
#
# Things that do NOT work, recorded so nobody re-tries them: putting the backend
# modules beside the executable or beside the dylibs (Homebrew's ggml makes zero
# load attempts -- it does not search either), and GGML_BACKEND_PATH (it dlopens
# the one literal path it is given, takes no separator, and one backend is not
# enough -- Metal alone then fails with "make_cpu_buft_list: no CPU backend
# found").
#
# WHAT UPSTREAM SHIPS INSTEAD. llama.cpp publishes a macos-arm64 tarball whose
# binary and every dylib -- backends included -- sit in ONE directory and use
# @loader_path. Nothing absolute, nothing from Homebrew: verified with `strings`
# (zero /opt/homebrew references) and by running it under the same sandbox that
# kills the Homebrew build, where it loads the model and serves. So this fetches
# that, keeps the layout flat because @loader_path requires it, and stops
# needing llama.cpp installed on the build machine at all.

import hashlib
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

dest = sys.argv[1]

# PINNED, and pinned the same way bridges/native.json pins the mautrix binaries:
# a tag plus a sha256 taken from the file that was actually tested. A release
# asset is mutable in principle -- the hash is what makes this reproducible, and
# a mismatch fails the build rather than shipping something unexamined.
TAG = 'b10701'
ASSET = f'llama-{TAG}-bin-macos-arm64.tar.gz'
URL = f'https://github.com/ggml-org/llama.cpp/releases/download/{TAG}/{ASSET}'
SHA256 = 'b696c798c58e3e02332c8ba2e4dc60ed5bd1508b7c49fb59b1216ca47f7be568'

# Only what the server needs. The tarball also carries llama-cli, llama-bench
# and friends; they are not shipped because nothing runs them, and every extra
# Mach-O is another thing build.sh has to sign and Apple has to notarize.
KEEP_PREFIXES = ('libggml', 'libllama', 'libmtmd')

bindir = os.path.join(dest, 'bin')
os.makedirs(bindir, exist_ok=True)

with tempfile.TemporaryDirectory() as work:
    tarball = os.path.join(work, ASSET)
    print(f'fetching llama.cpp {TAG}')
    urllib.request.urlretrieve(URL, tarball)

    got = hashlib.sha256(open(tarball, 'rb').read()).hexdigest()
    if got != SHA256:
        # Deleted, not left on disk: a mismatched archive is the one thing that
        # must never become a build input, and a half-trusted file sitting in a
        # temp dir is how that happens by accident later.
        os.unlink(tarball)
        sys.exit(f'ERROR: {ASSET} sha256 {got}\n       expected {SHA256}')
    print(f'  sha256 verified ({os.path.getsize(tarball) // 1024 // 1024} MB)')

    with tarfile.open(tarball) as tf:
        tf.extractall(work, filter='data')

    src = None
    for root, _dirs, files in os.walk(work):
        if 'llama-server' in files:
            src = root
            break
    if src is None:
        sys.exit('ERROR: no llama-server in the release tarball')

    # FLAT, deliberately. Both the binary and every backend module carry an
    # rpath of @loader_path, so they resolve each other by sitting together.
    # Splitting them into bin/ and lib/ -- which is what the previous layout did
    # -- breaks exactly the dlopen this whole file exists to fix.
    staged = 0
    for name in sorted(os.listdir(src)):
        path = os.path.join(src, name)
        if not os.path.isfile(path):
            continue
        if name == 'llama-server' or (name.endswith('.dylib') and name.startswith(KEEP_PREFIXES)):
            shutil.copy2(path, os.path.join(bindir, name))
            staged += 1
    os.chmod(os.path.join(bindir, 'llama-server'), 0o755)

backends = sorted(f for f in os.listdir(bindir)
                  if f.startswith(('libggml-metal', 'libggml-cpu', 'libggml-blas')))
print(f'staged llama-server + {staged - 1} dylibs -> {bindir}')
print(f'  backends: {", ".join(backends) or "NONE"}')

# THE CHECK THIS FILE SHOULD ALWAYS HAVE HAD, in both directions.
#
# A runtime with no backend module cannot load a model anywhere, and a runtime
# naming an absolute Homebrew path can only load one on the machine that built
# it. Either shipped silently before. Both stop the build now: local answering
# should not fail quietly at a user's first question.
problems = []
if not backends:
    problems.append('no ggml backend modules were staged (Metal/CPU/BLAS)')
for name in sorted(os.listdir(bindir)):
    with open(os.path.join(bindir, name), 'rb') as fh:
        if b'/opt/homebrew' in fh.read():
            problems.append(f'{name} references /opt/homebrew, so it is not portable')
if problems:
    for p in problems:
        print(f'  ERROR: {p}', file=sys.stderr)
    sys.exit(1)

# rpath is @loader_path in upstream's build; assert it rather than assume, since
# a future release changing it would reintroduce this class of bug quietly.
rpaths = subprocess.run(['otool', '-l', os.path.join(bindir, 'llama-server')],
                        capture_output=True, text=True).stdout
if '@loader_path' not in rpaths:
    sys.exit('ERROR: llama-server no longer uses @loader_path; the flat layout '
             'above depends on it')
print('  portable: no absolute paths, backends present, @loader_path intact')
