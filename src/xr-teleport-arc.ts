import { Vec3 } from 'playcanvas';
import type { Entity, MeshInstance, XrInputSource } from 'playcanvas';

// The members of the engine's XR teleport (playcanvas/scripts/esm/xr/xr-navigation.mjs) its arc
// reads, and the three the viewer replaces: the script's own typing is Script, and these are its
// private methods, so check them when updating the engine
type TeleportArcNavigation = {
    entity: Entity;
    castRay: ((from: Vec3, to: Vec3) => Vec3 | null) | null;
    groundHeight: number;
    maxTeleportDistance: number;
    teleportArcSpeed: number;
    isValidTeleportDistance(point: Vec3): boolean;
    _arcPoints: Vec3[];
    _getAimRay(inputSource: XrInputSource): void;
    _computeArcHit(origin: Vec3, direction: Vec3, rec: { point: Vec3; valid: boolean }): void;
    _getArcVisual(inputSource: XrInputSource): { meshInstance: MeshInstance; ringEntity: Entity };
};

// The draw bucket of what XR draws over the scene (the arc, its ring, the floor grid, the menu).
// The World layer draws its transparent instances by bucket, then back to front by their centres,
// and the sorted renderer's splats are one transparent instance, whose centre can lie nearer than
// the arc: it would then draw over it. A bucket below theirs (127) draws after them
const XR_OVERLAY_DRAW_BUCKET = 0;

// the engine's gravity for the arc
const ARC_GRAVITY = 9.81;

// For the look aim, how far the arc rises above the line from the hand to the target at its
// middle, as a share of that line's length
const ARC_LIFT = 0.15;

/**
 * Replaces the teleport's arc. Its ballistic arc ends at what it hits, where the released engine's
 * collapses its samples past the hit onto it, which twists the ribbon's end. And a pinch whose
 * ray follows the eyes (a transient pointer: Apple Vision Pro's look and pinch) teleports where
 * that ray first meets the ground, the arc drawn from the hand to it.
 * visionOS reveals the eyes' direction only as the pinch starts; the hand then moves the ray.
 * Controllers keep the ballistic arc. The arc and its ring draw after the splats. The ballistic
 * arc is TEMPORARY (see `ballistic` below); the look aim and the draw order stay.
 *
 * @param navigation - The XrNavigation script.
 */
const replaceTeleportArc = (navigation: TeleportArcNavigation) => {
    const points = navigation._arcPoints;
    const segments = points.length - 1;

    // the input source the navigation is aiming, which its arc is not given
    let source: XrInputSource | null = null;
    const getAimRay = navigation._getAimRay.bind(navigation);
    navigation._getAimRay = (inputSource: XrInputSource) => {
        source = inputSource;
        getAimRay(inputSource);
    };

    // the arc and ring the navigation makes for an input source, on its first aim
    const getArcVisual = navigation._getArcVisual.bind(navigation);
    navigation._getArcVisual = (inputSource: XrInputSource) => {
        const visual = getArcVisual(inputSource);
        if (visual.meshInstance.drawBucket !== XR_OVERLAY_DRAW_BUCKET) {
            visual.meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
            for (const meshInstance of visual.ringEntity.render.meshInstances) {
                meshInstance.drawBucket = XR_OVERLAY_DRAW_BUCKET;
            }
        }
        return visual;
    };

    // the arc's positions at even steps over its first duration seconds
    const sample = (origin: Vec3, vx: number, vy: number, vz: number, duration: number) => {
        for (let i = 0; i <= segments; i++) {
            const t = (duration * i) / segments;
            points[i].set(origin.x + vx * t, origin.y + vy * t - 0.5 * ARC_GRAVITY * t * t, origin.z + vz * t);
        }
    };

    // The engine's ballistic arc, to the navigation's plane or the first segment castRay hits, and
    // sampled again to end at the hit, so the ribbon keeps all its segments and fades out there.
    // TEMPORARY: the engine's _computeArcHit does the same with playcanvas/engine#9750. Once the
    // viewer requires an engine with it, bind that before replacing it and call it in place of this
    // validate false lands the arc without testing the landing (the test also publishes the landing
    // to the floor grid, xr.ts), for an arc that may not teleport
    const ballistic = (origin: Vec3, direction: Vec3, rec: { point: Vec3; valid: boolean }, validate = true) => {
        const speed = navigation.teleportArcSpeed;
        const vx = direction.x * speed;
        const vy = direction.y * speed;
        const vz = direction.z * speed;
        rec.valid = false;

        let flight;
        let planeHit = false;
        if (navigation.castRay) {
            // down to the deepest point that could still pass the distance check, which measures
            // from the rig, below the hand
            const fallDepth =
                navigation.maxTeleportDistance + Math.max(0, origin.y - navigation.entity.getPosition().y);
            flight = (vy + Math.sqrt(vy * vy + 2 * ARC_GRAVITY * fallDepth)) / ARC_GRAVITY;
        } else {
            const disc = vy * vy + 2 * ARC_GRAVITY * (origin.y - navigation.groundHeight);
            flight = disc >= 0 ? (vy + Math.sqrt(disc)) / ARC_GRAVITY : 0;
            planeHit = flight > 0.001;
            if (!planeHit) flight = (2 * speed) / ARC_GRAVITY;
        }
        sample(origin, vx, vy, vz, flight);

        if (navigation.castRay) {
            for (let i = 0; i < segments; i++) {
                const start = points[i];
                const end = points[i + 1];
                const hit = navigation.castRay(start, end);
                if (hit) {
                    rec.point.copy(hit);
                    // the hit's flight time, from where it lies along the segment
                    const length = start.distance(end);
                    const along = length > 1e-6 ? Math.min(start.distance(rec.point) / length, 1) : 0;
                    sample(origin, vx, vy, vz, (flight * (i + along)) / segments);
                    points[segments].copy(rec.point);
                    rec.valid = validate && navigation.isValidTeleportDistance(rec.point);
                    return;
                }
            }
        } else if (planeHit) {
            rec.point.copy(points[segments]);
            rec.point.y = navigation.groundHeight;
            rec.valid = validate && navigation.isValidTeleportDistance(rec.point);
        }
    };

    // The look aim: the target where the input source's ray first meets the ground, and the arc a
    // parabola from the hand through it, its middle ARC_LIFT of the distance above the line between
    // them (g * duration^2 / 8). False where the ray meets nothing
    const rayOrigin = new Vec3();
    const rayDirection = new Vec3();
    const rayEnd = new Vec3();
    const hand = new Vec3();
    const look = (inputSource: XrInputSource, rec: { point: Vec3; valid: boolean }) => {
        // copy at once: the input source reuses these vectors
        rayOrigin.copy(inputSource.getOrigin());
        rayDirection.copy(inputSource.getDirection());
        hand.copy(inputSource.grip ? inputSource.getPosition() : rayOrigin);

        const reach = navigation.maxTeleportDistance * 2;
        let hit: Vec3 | null = null;
        if (navigation.castRay) {
            rayEnd.copy(rayDirection).mulScalar(reach).add(rayOrigin);
            hit = navigation.castRay(rayOrigin, rayEnd);
        } else if (rayDirection.y < -0.001) {
            const t = (rayOrigin.y - navigation.groundHeight) / -rayDirection.y;
            if (t > 0 && t < reach) hit = rayEnd.copy(rayDirection).mulScalar(t).add(rayOrigin);
        }
        if (!hit) return false;

        rec.point.copy(hit);
        rec.valid = navigation.isValidTeleportDistance(rec.point);
        const dx = rec.point.x - hand.x;
        const dy = rec.point.y - hand.y;
        const dz = rec.point.z - hand.z;
        const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const duration = Math.max(Math.sqrt((8 * ARC_LIFT * length) / ARC_GRAVITY), 0.01);
        sample(hand, dx / duration, dy / duration + 0.5 * ARC_GRAVITY * duration, dz / duration, duration);
        points[segments].copy(rec.point);
        return true;
    };

    navigation._computeArcHit = (origin: Vec3, direction: Vec3, rec: { point: Vec3; valid: boolean }) => {
        if (source?.targetRayMode === 'transient-pointer') {
            if (look(source, rec)) return;
            // nothing where the eyes are: the hand's arc, landing nowhere
            ballistic(origin, direction, rec, false);
            return;
        }
        ballistic(origin, direction, rec);
    };
};

export { replaceTeleportArc, XR_OVERLAY_DRAW_BUCKET };
export type { TeleportArcNavigation };
