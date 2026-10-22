#!/usr/bin/env bash
# Rebuilds the committed gsaf decoder (lib/gsaf/) from a gsaf checkout with emsdk. A normal
# viewer build never runs this: it bundles the committed output, so only a decoder update needs
# the toolchain.
#
# Usage: GSAF_DIR=<gsaf checkout> EMSDK=<emsdk checkout> scripts/build-gsaf.sh
#
# The output is emscripten's glue, a classic script defining `createGsafModule`, and the wasm beside
# it. The glue is bundled: src/gsaf/gsaf-worker.ts appends its own code to it and starts the pair as
# a blob worker, so it targets a worker environment only. The wasm ships as its own file, fetched
# and compiled only when a gsaf file loads, and handed to the worker compiled, so the glue never
# fetches it itself. DYNAMIC_EXECUTION=0 keeps embind from compiling its invokers with
# `new Function`, which a page's CSP may refuse.
set -euo pipefail

VIEWER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GSAF_DIR="${GSAF_DIR:-${VIEWER_DIR}/../../research/gsaf}"
EMSDK="${EMSDK:-${VIEWER_DIR}/../../emsdk}"
BUILD_DIR="${GSAF_BUILD_DIR:-${VIEWER_DIR}/build/gsaf-wasm}"
OUT_DIR="${VIEWER_DIR}/lib/gsaf"

# shellcheck disable=SC1091
source "${EMSDK}/emsdk_env.sh" >/dev/null

FLAGS=(
    -G Ninja
    -DCMAKE_BUILD_TYPE=Release
    -DGSAF_BUILD_WASM_BINDINGS=ON
    -DGSAF_WITH_ENCODER=OFF
    -DGSAF_BUILD_INSPECT=OFF
    -DGSAF_BUILD_PLY=OFF
    -DGSAF_BUILD_CLI=OFF
    -DGSAF_BUILD_TESTS=OFF
    -DGSAF_BUILD_EXAMPLES=OFF
    -DGSAF_BUILD_DEV_TOOLS=OFF
    # glm's pinned CMakeLists declares cmake_minimum_required(VERSION 3.2), which CMake 4 refuses
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5
    # wasm SIMD engages xsimd's wasm backend; every browser the viewer supports has it
    "-DCMAKE_C_FLAGS=-msimd128"
    "-DCMAKE_CXX_FLAGS=-msimd128"
    "-DCMAKE_EXE_LINKER_FLAGS=-sENVIRONMENT=worker -sDYNAMIC_EXECUTION=0"
    "-DGSAF_WASM_GIT_COMMIT=$(git -C "${GSAF_DIR}" rev-parse --short HEAD)"
)

# reuse glm and xsimd sources a previous gsaf build fetched, if there are any
for dep in glm xsimd; do
    src="$(find "${GSAF_DIR}/build" -maxdepth 3 -type d -name "${dep}-src" -print -quit 2>/dev/null || true)"
    if [[ -n "${src}" ]]; then
        FLAGS+=("-DFETCHCONTENT_SOURCE_DIR_$(echo "${dep}" | tr '[:lower:]' '[:upper:]')=${src}")
    fi
done

emcmake cmake -S "${GSAF_DIR}" -B "${BUILD_DIR}" "${FLAGS[@]}"
cmake --build "${BUILD_DIR}" --target gsaf-wasm

mkdir -p "${OUT_DIR}"
cp -f "${BUILD_DIR}/bindings/wasm/gsaf-decoder.js" "${OUT_DIR}/gsaf-decoder.js"
cp -f "${BUILD_DIR}/bindings/wasm/gsaf-decoder.wasm" "${OUT_DIR}/gsaf-decoder.wasm"
cat > "${OUT_DIR}/VERSION" <<EOF
gsaf $(git -C "${GSAF_DIR}" describe --tags --always --dirty)
emscripten $(emcc --version | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')
EOF
ls -l "${OUT_DIR}"
cat "${OUT_DIR}/VERSION"
