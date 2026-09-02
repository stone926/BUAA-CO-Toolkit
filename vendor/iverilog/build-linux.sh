#!/usr/bin/env bash
# Build the complete native Ubuntu 22.04 Icarus prefix from the shared source manifest.
set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "Usage: $0 <linux-x64|linux-arm64> <new-output-directory> <source-url> <source-sha256>" >&2
  echo "Read the source URL and SHA-256 from vendor/iverilog/CORRESPONDING_SOURCES.json." >&2
  exit 2
fi

target="$1"
output_dir="$(realpath -m -- "$2")"
source_url="$3"
source_sha256="$4"

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) native_target=linux-x64 ;;
  Linux/aarch64) native_target=linux-arm64 ;;
  *) echo 'Build on native Linux x64 or ARM64; cross-compilation is not supported.' >&2; exit 1 ;;
esac
if [[ "$target" != "$native_target" ]]; then
  echo "Requested ${target}, but this machine is ${native_target}." >&2
  exit 1
fi

# Keep the advertised system-library baseline tied to the actual build environment.
source /etc/os-release
if [[ "${ID:-}" != ubuntu || "${VERSION_ID:-}" != 22.04 ]]; then
  echo 'Build inside the ubuntu:22.04 container to preserve the supported runtime baseline.' >&2
  exit 1
fi
if [[ -e "$output_dir" || -L "$output_dir" ]]; then
  echo "Output directory already exists: ${output_dir}" >&2
  exit 1
fi
if [[ "$source_url" != https://* || ! "$source_sha256" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo 'Expected an HTTPS source URL and a 64-character SHA-256 from the shared manifest.' >&2
  exit 2
fi
jobs="${IVERILOG_BUILD_JOBS:-$(nproc)}"
if [[ ! "$jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo 'IVERILOG_BUILD_JOBS must be a positive integer.' >&2
  exit 2
fi

build_dir="$(mktemp -d)"
trap 'rm -rf -- "$build_dir"' EXIT
archive="${build_dir}/v13_0.tar.gz"
source_dir="${build_dir}/source"
stage="${build_dir}/stage"
mkdir -p "$source_dir" "$stage"
curl --fail --location --retry 3 --output "$archive" "$source_url"
printf '%s  %s\n' "$source_sha256" "$archive" | sha256sum --check --strict
tar -xzf "$archive" --strip-components=1 -C "$source_dir"

(
  cd "$source_dir"
  env CC=gcc CXX=g++ CFLAGS=-O2 CXXFLAGS=-O2 LDFLAGS= \
    ac_cv_lib_termcap_tputs=no \
    ac_cv_lib_readline_readline=no \
    ac_cv_lib_readline_add_history=no \
    ac_cv_lib_history_add_history=no \
    ac_cv_lib_z_gzwrite=no \
    ac_cv_lib_bz2_BZ2_bzdopen=no \
    ./configure --prefix=/opt/co-iverilog --libdir=/opt/co-iverilog/lib
  make -j"$jobs"
  make DESTDIR="$stage" install
)

prefix="${stage}/opt/co-iverilog"
mkdir -p "${prefix}/licenses"
cp "${source_dir}/COPYING" "${prefix}/licenses/iverilog-COPYING.txt"
cat > "${prefix}/THIRD_PARTY_NOTICES.md" <<EOF
# Third-party notices for the bundled ${target} Icarus runtime

This directory contains the complete Icarus Verilog 13.0 installation prefix
built from the unmodified upstream v13_0 source archive on native ${target}
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
- Source URL: <${source_url}>
- Source SHA-256: ${source_sha256}
- Shared source manifest: [CORRESPONDING_SOURCES.json](../CORRESPONDING_SOURCES.json)
- Build recipe: [build-linux.sh](../build-linux.sh)
- Build environment: Ubuntu 22.04, native ${target}; GCC/G++, make, bison and flex
- C compiler: $(gcc -dumpfullversion)
- C++ compiler: $(g++ -dumpfullversion)

The source archive is also distributed with the extension's GitHub Release
attachments and its SHA-256 is recorded in the release's SHA256SUMS file.

## Build configuration

The build uses the upstream configure script without patches, with these
explicit environment variables and arguments:

\`\`\`sh
CC=gcc CXX=g++ CFLAGS=-O2 CXXFLAGS=-O2 LDFLAGS= \\
ac_cv_lib_termcap_tputs=no \\
ac_cv_lib_readline_readline=no \\
ac_cv_lib_readline_add_history=no \\
ac_cv_lib_history_add_history=no \\
ac_cv_lib_z_gzwrite=no \\
ac_cv_lib_bz2_BZ2_bzdopen=no \\
./configure --prefix=/opt/co-iverilog --libdir=/opt/co-iverilog/lib
make -j${jobs}
make DESTDIR="<temporary staging directory>" install
\`\`\`

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
EOF

mkdir -p "$output_dir"
cp -a "${prefix}/." "$output_dir/"
printf 'Built complete %s runtime at %s\n' "$target" "$output_dir"
