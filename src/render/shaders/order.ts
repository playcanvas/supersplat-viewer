// The ordering passes (variant order:bucket): the projector counts its survivors into 256
// depth buckets, front to back; a one-workgroup scan turns the counts into bucket offsets, and
// the scatter writes each survivor's cache slot into the ordered list the raster then follows.
// Splats inside a bucket land in append order, so a bucket keeps its chunks' locality.

import { CACHE_WORDS, ORDER_BUCKETS } from './projector';

// exclusive prefix sum of the bucket counts into the bucket offsets, in one workgroup
const orderScanWGSL = /* wgsl */ `
// [0, ${ORDER_BUCKETS}) counts, [${ORDER_BUCKETS}, ${2 * ORDER_BUCKETS}) offsets
@group(0) @binding(0) var<storage, read_write> buckets: array<u32>;

var<workgroup> partial: array<u32, ${ORDER_BUCKETS}>;

@compute @workgroup_size(${ORDER_BUCKETS})
fn main(@builtin(local_invocation_index) local: u32) {
    partial[local] = buckets[local];
    for (var stride = 1u; stride < ${ORDER_BUCKETS}u; stride <<= 1u) {
        workgroupBarrier();
        let value = select(0u, partial[local - stride], local >= stride);
        workgroupBarrier();
        partial[local] += value;
    }
    // inclusive to exclusive
    buckets[${ORDER_BUCKETS}u + local] = partial[local] - buckets[local];
}
`;

// One thread per cache slot, one workgroup per 256 consecutive slots. Consecutive slots come
// from one chunk, so a workgroup touches few buckets: it counts them locally, claims each
// bucket's range with one global atomic, and places its splats in append order inside it.
const orderScatterWGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> counter: array<u32>;
@group(0) @binding(1) var<storage, read> cache: array<u32>;
@group(0) @binding(2) var<storage, read_write> buckets: array<atomic<u32>>;
@group(0) @binding(3) var<storage, read_write> ordered: array<u32>;

var<workgroup> wgCounts: array<atomic<u32>, ${ORDER_BUCKETS}>;
var<workgroup> wgBase: array<u32, ${ORDER_BUCKETS}>;

@compute @workgroup_size(${ORDER_BUCKETS})
fn main(
    @builtin(workgroup_id) wg: vec3u,
    @builtin(num_workgroups) numWorkgroups: vec3u,
    @builtin(local_invocation_index) local: u32
) {
    // no early returns: the barriers need every thread
    atomicStore(&wgCounts[local], 0u);
    let slot = (wg.x + wg.y * numWorkgroups.x) * ${ORDER_BUCKETS}u + local;
    let live = slot < counter[0];
    var key = 0u;
    var rank = 0u;
    workgroupBarrier();
    if (live) {
        key = cache[slot * ${CACHE_WORDS}u + 3u] >> 24u;
        rank = atomicAdd(&wgCounts[key], 1u);
    }
    workgroupBarrier();
    let count = atomicLoad(&wgCounts[local]);
    if (count > 0u) {
        wgBase[local] = atomicAdd(&buckets[${ORDER_BUCKETS}u + local], count);
    }
    workgroupBarrier();
    if (live) {
        ordered[wgBase[key] + rank] = slot;
    }
}
`;

export { orderScanWGSL, orderScatterWGSL };
