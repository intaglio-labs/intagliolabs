#!/usr/bin/env python3
# Make a PORTABLE copy of Homebrew's llama-server + every non-system dylib it
# needs (recursively), with all install names rewritten to @rpath/<name> and an
# rpath of @loader_path/../lib on the binary — so the whole thing runs from
# anywhere, with no Homebrew. Verified to keep Metal GPU inference working
# (the Metal backend is embedded in libggml). Usage: bundle-llama.py <destdir>
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
