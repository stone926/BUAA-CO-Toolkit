# Third-party notices for the bundled macOS arm64 Icarus runtime

This directory contains the complete `13.0` installation prefix extracted
from Homebrew's official `icarus-verilog` `arm64_sonoma` bottle. It is
distributed with BUAA CO Toolkit for the extension's Verilog compiler and
simulator integration. Icarus Verilog remains under its upstream licenses;
the repository's top-level license does not replace or restrict them.

No executable or library in the Homebrew prefix was modified. BUAA CO Toolkit
only adds this notice, [`BOTTLE_MANIFEST.json`](BOTTLE_MANIFEST.json), the
shared corresponding-source manifest, and a duplicate of the bottle's
`COPYING` file under [`licenses/`](licenses/iverilog-COPYING.txt) for a stable
packaging path.

## Provenance

- Homebrew formula: `homebrew/core/icarus-verilog` `13.0`, formula revision `0`
- Bottle tag: `arm64_sonoma` (Apple Silicon, Sonoma/macOS 14 deployment target)
- Bottle URL: <https://ghcr.io/v2/homebrew/core/icarus-verilog/blobs/sha256:936627d8dfbb9996d55b3f3044f6bdf45e433df0c5fe9d0f8390f1a35714978b>
- Bottle SHA-256: `936627d8dfbb9996d55b3f3044f6bdf45e433df0c5fe9d0f8390f1a35714978b`
- Bottle size: `2140973` bytes
- Homebrew formula snapshot: [`.brew/icarus-verilog.rb`](.brew/icarus-verilog.rb)
- Homebrew-generated SBOM: [`sbom.spdx.json`](sbom.spdx.json)

The formula declares no Homebrew runtime package dependencies on macOS. The
binaries use macOS system libraries, including the system-provided bzip2
library; no Homebrew installation is required at runtime.

## Icarus Verilog 13.0

- Upstream: <https://github.com/steveicarus/iverilog>
- License declared by the Homebrew formula: `GPL-2.0-or-later AND LGPL-2.1-or-later`
- Copyright: the Icarus Verilog contributors
- Upstream source: <https://github.com/steveicarus/iverilog/archive/refs/tags/v13_0.tar.gz>
- Source SHA-256: `c897bbfa9848688982c6d5c30529fc29d68df0b9ff22ffa73bad89db73a7ce49`
- Source manifest: [`../CORRESPONDING_SOURCES.json`](../CORRESPONDING_SOURCES.json)
- License text shipped in the bottle: [`COPYING`](COPYING)
- Stable license copy: [`licenses/iverilog-COPYING.txt`](licenses/iverilog-COPYING.txt)
