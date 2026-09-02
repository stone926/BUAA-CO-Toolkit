# Third-party notices for the bundled linux-arm64 Icarus runtime

This directory contains the complete Icarus Verilog 13.0 installation prefix
built from the unmodified upstream v13_0 source archive on native linux-arm64
in an Ubuntu 22.04 container. It is distributed with BUAA CO Toolkit for the
extension's Verilog compiler and simulator integration. Icarus Verilog
remains under its upstream licenses; the repository's top-level license
does not replace or restrict them.

BUAA CO Toolkit adds this notice and a copy of the upstream license text
under [licenses/](licenses/iverilog-COPYING.txt). The complete installed
prefix is retained, including targets, VPI modules, headers and documentation.

## Provenance and corresponding source

- Upstream: <https://github.com/steveicarus/iverilog>
- Version: Icarus Verilog 13.0, tag v13_0
- Copyright and license terms: [upstream COPYING](licenses/iverilog-COPYING.txt)
- Source URL: <https://github.com/steveicarus/iverilog/archive/refs/tags/v13_0.tar.gz>
- Source SHA-256: c897bbfa9848688982c6d5c30529fc29d68df0b9ff22ffa73bad89db73a7ce49
- Shared source manifest: [CORRESPONDING_SOURCES.json](../CORRESPONDING_SOURCES.json)
- Build recipe: [build-linux.sh](../build-linux.sh)
- Build environment: Ubuntu 22.04, native linux-arm64; GCC/G++, make, bison and flex
- C compiler: 11.4.0
- C++ compiler: 11.4.0

The source archive is also distributed with the extension's GitHub Release
attachments and its SHA-256 is recorded in the release's SHA256SUMS file.

## Build configuration

The build uses the upstream configure script without patches, with these
explicit environment variables and arguments:

```sh
CC=gcc CXX=g++ CFLAGS=-O2 CXXFLAGS=-O2 LDFLAGS= \
ac_cv_lib_termcap_tputs=no \
ac_cv_lib_readline_readline=no \
ac_cv_lib_readline_add_history=no \
ac_cv_lib_history_add_history=no \
ac_cv_lib_z_gzwrite=no \
ac_cv_lib_bz2_BZ2_bzdopen=no \
./configure --prefix=/opt/co-iverilog --libdir=/opt/co-iverilog/lib
make -j4
make DESTDIR="<temporary staging directory>" install
```

No native-CPU optimization or libvvp shared-library mode is enabled. The
runtime uses the host's standard glibc, libstdc++, libgcc and other system
libraries; these system libraries are not bundled. It does not require
Homebrew or use a private dynamic loader or LD_LIBRARY_PATH.

Optional termcap, readline, history, zlib and bzip2 library probes are
disabled. Verilog compilation, text output, readmemh and basic VCD output
remain available. FST/LXT/LXT2 compressed waveforms and readline line
editing are not provided.

The installation prefix is relocated by the extension, which invokes the
bundled compiler with -B pointing to this runtime's lib/ivl directory and
runs the bundled vvp explicitly.
