// Neutral camera/input domain modes, shared by the input, cameras, and
// navigation libraries. Kept here (not in the app `types.ts`, which also
// declares `Global`/`Config`/`State`) so the libraries don't depend on app
// types. `types.ts` re-exports these for app back-compat.
type CameraMode = 'orbit' | 'anim' | 'fly' | 'walk';

type InputMode = 'desktop' | 'touch';

export type { CameraMode, InputMode };
