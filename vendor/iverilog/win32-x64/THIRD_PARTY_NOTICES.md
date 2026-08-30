# Third-party notices for the bundled Windows x64 Icarus runtime

This directory contains an unmodified runtime assembled from the MSYS2 UCRT64
binary packages listed below. It is distributed with BUAA CO Toolkit for use by
the extension's Verilog compiler and simulator integration. These components
remain under their respective licenses; the repository's top-level license does
not replace or restrict those licenses.

The snapshot was assembled on 2026-08-30. Each exact MSYS2 source-only archive
contains the corresponding upstream source, MSYS2 packaging recipe, and applied
patches for the listed binary package. The copied license texts are in
[`licenses/`](licenses/).

The machine-readable source archive names, URLs, sizes, and SHA-256 digests are
recorded in [`CORRESPONDING_SOURCES.json`](CORRESPONDING_SOURCES.json). Every
BUAA CO Toolkit release that distributes this runtime attaches those seven verified
source archives and a `SHA256SUMS` file alongside the VSIX, so corresponding source remains available
from the [project release page](https://github.com/stone926/BUAA-CO-Toolkit/releases)
without depending exclusively on the MSYS2 mirror.

## Components

### Icarus Verilog 13.0

- MSYS2 package: `mingw-w64-ucrt-x86_64-iverilog` `1~13.0-2`
- License: GPL-2.0-or-later
- Copyright: the Icarus Verilog contributors
- Included files: `bin/iverilog.exe`, `bin/iverilog-vpi.exe`, `bin/vvp.exe`,
  and the complete package `lib/ivl` runtime directory
- Binary package: <https://mirror.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-iverilog-1~13.0-2-any.pkg.tar.zst>
- Binary SHA-256: `fd4d7d7cb60cda1eb437f5476673503d92964cf47ce6c11b460eb3bd05c43582`
- Corresponding source: <https://mirror.msys2.org/mingw/sources/mingw-w64-iverilog-1~13.0-2.src.tar.zst>
- Source SHA-256: `fce280b0f1f475c14ba9eddeb1c4fa9dde45da802961003960d9911c5fcb869c`
- License text: [`licenses/iverilog-COPYING.txt`](licenses/iverilog-COPYING.txt)

### bzip2 1.0.8

- MSYS2 package: `mingw-w64-ucrt-x86_64-bzip2` `1.0.8-4`
- License: bzip2 license (BSD-style)
- Copyright: Copyright (C) 1996-2019 Julian R Seward
- Included file: `bin/libbz2-1.dll`
- Binary package: <https://mirror.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-bzip2-1.0.8-4-any.pkg.tar.zst>
- Binary SHA-256: `f03a2174034ddd2d96cecd34f617c5f8e2ef86c812b8d2bb3b8875257f2c8bfa`
- Corresponding source: <https://mirror.msys2.org/mingw/sources/mingw-w64-bzip2-1.0.8-4.src.tar.zst>
- Source SHA-256: `fd9360917314d1cbccb3cb15ed8450d1e56b8a9f733b606504aba52c52159e54`
- License text: [`licenses/bzip2-LICENSE.txt`](licenses/bzip2-LICENSE.txt)

### GNU Readline 8.3.003

- MSYS2 package: `mingw-w64-ucrt-x86_64-readline` `8.3.003-1`
- License: GPL-3.0-or-later
- Copyright: the Free Software Foundation, Inc. and Readline contributors
- Included files: `bin/libreadline8.dll` and `bin/libhistory8.dll`
- Binary package: <https://mirror.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-readline-8.3.003-1-any.pkg.tar.zst>
- Binary SHA-256: `de2423c2e10fcd88272a0ab2f833f6a082cfe613d4c17c2f548cc50a5d2190c4`
- Corresponding source: <https://mirror.msys2.org/mingw/sources/mingw-w64-readline-8.3.003-1.src.tar.zst>
- Source SHA-256: `1e2713dd55f795920d5784ab2e7a797dd7ce7392a4cf1991f9b848e25ae1f95d`
- License text: [`licenses/readline-COPYING.txt`](licenses/readline-COPYING.txt)

### zlib 1.3.2

- MSYS2 package: `mingw-w64-ucrt-x86_64-zlib` `1.3.2-2`
- License: Zlib
- Copyright: Copyright (C) 1995-2026 Jean-loup Gailly and Mark Adler
- Included file: `bin/zlib1.dll`
- Binary package: <https://mirror.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-zlib-1.3.2-2-any.pkg.tar.zst>
- Binary SHA-256: `841401182976d2f9e17e5c0ebaac51f2a8014140ea53d67625e91c8fb3c85ea0`
- Corresponding source: <https://mirror.msys2.org/mingw/sources/mingw-w64-zlib-1.3.2-2.src.tar.zst>
- Source SHA-256: `eef69dea52357e01b272d6fd6dc4d7c0773f71260cb7bcde6047c8c383518db3`
- License text: [`licenses/zlib-LICENSE.txt`](licenses/zlib-LICENSE.txt)

### GNU termcap 1.3.1

- MSYS2 package: `mingw-w64-ucrt-x86_64-termcap` `1.3.1-7`
- License: GPL-2.0-or-later for the source files used to build the distributed
  library (`termcap.c`, `tparam.c`, and `version.c`)
- Copyright: the Free Software Foundation, Inc.
- Included file: `bin/libtermcap-0.dll`
- Binary package: <https://mirror.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-termcap-1.3.1-7-any.pkg.tar.zst>
- Binary SHA-256: `17b78eb63e89458a6ae4d56aa1dc357e1decb2f845b29fded79bccdd628d9d41`
- Corresponding source: <https://mirror.msys2.org/mingw/sources/mingw-w64-termcap-1.3.1-7.src.tar.zst>
- Source SHA-256: `6a1207578fd39b64924fcdfcacc1c862ba3c714477dd662ba20da8d9b4cbd4ed`
- License text: [`licenses/termcap-COPYING.txt`](licenses/termcap-COPYING.txt)

### GCC runtime libraries 16.2.0

- MSYS2 package: `mingw-w64-ucrt-x86_64-gcc-libs` `16.2.0-3`
- Licenses: GPL-3.0-or-later WITH GCC-exception-3.1 for libgcc, libstdc++,
  libgomp, and libatomic; LGPL-2.1-or-later for libquadmath
- Copyright: the Free Software Foundation, Inc. and GCC contributors
- Included files: `bin/libatomic-1.dll`, `bin/libgcc_s_seh-1.dll`,
  `bin/libgomp-1.dll`, `bin/libquadmath-0.dll`, and `bin/libstdc++-6.dll`
- Binary package: <https://mirror.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-gcc-libs-16.2.0-3-any.pkg.tar.zst>
- Binary SHA-256: `5763fabf86fa13a4449ee765006d3446384ed66af7bf827459710eb777e0b11c`
- Corresponding source: <https://mirror.msys2.org/mingw/sources/mingw-w64-gcc-16.2.0-3.src.tar.zst>
- Source SHA-256: `eb3479a8b0b23810fbbbc25ef76879e867e88d09960a40145d73f5505fda4da0`
- License texts: [`licenses/gcc-libs-COPYING3.txt`](licenses/gcc-libs-COPYING3.txt),
  [`licenses/gcc-libs-COPYING.RUNTIME.txt`](licenses/gcc-libs-COPYING.RUNTIME.txt),
  [`licenses/gcc-libs-COPYING.LIB.txt`](licenses/gcc-libs-COPYING.LIB.txt), and
  [`licenses/gcc-libs-README.txt`](licenses/gcc-libs-README.txt)

### MinGW-w64 winpthreads 14.0.0

- MSYS2 package: `mingw-w64-ucrt-x86_64-libwinpthread`
  `14.0.0.r302.gd7f3c5201-1`
- Licenses: MIT AND BSD-3-Clause-Clear
- Copyright: Copyright (c) 2011 mingw-w64 project, with portions derived from
  the POSIX Threads library for Microsoft Windows
- Included file: `bin/libwinpthread-1.dll`
- Binary package: <https://mirror.msys2.org/mingw/ucrt64/mingw-w64-ucrt-x86_64-libwinpthread-14.0.0.r302.gd7f3c5201-1-any.pkg.tar.zst>
- Binary SHA-256: `585a24715e00130e4973a6f4806a0c728443ff035f7c78b0683974474424b30f`
- Corresponding source: <https://mirror.msys2.org/mingw/sources/mingw-w64-winpthreads-14.0.0.r302.gd7f3c5201-1.src.tar.zst>
- Source SHA-256: `f3375ec5a49a45502840dd50ebf8f2c5a86efdd649acebb920134b9b02e3af9d`
- License text: [`licenses/winpthreads-COPYING.txt`](licenses/winpthreads-COPYING.txt)

## System components

The runtime also imports Windows system libraries and Universal C Runtime API
sets supplied by supported Windows 10/11 installations. Windows resolves the
logical `api-ms-win-crt-*.dll` imports to its serviced system `ucrtbase.dll`;
those operating-system components are not copied into this directory. The
extension prepends this runtime's `bin` directory only for its child processes
so that unrelated MinGW DLLs elsewhere on a user's `PATH` cannot satisfy these
imports first.
