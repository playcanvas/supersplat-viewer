type Obj = Record<string, unknown>;

const assertObject = (value: unknown, path: string): Obj => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
    }
    return value as Obj;
};

const assertNumber = (value: unknown, path: string): number => {
    if (typeof value !== 'number' || !isFinite(value)) {
        throw new Error(`${path} must be a finite number`);
    }
    return value;
};

const assertString = (value: unknown, path: string): string => {
    if (typeof value !== 'string') {
        throw new Error(`${path} must be a string`);
    }
    return value;
};

const assertBoolean = (value: unknown, path: string): boolean => {
    if (typeof value !== 'boolean') {
        throw new Error(`${path} must be a boolean`);
    }
    return value;
};

const assertEnum = <T extends string>(value: unknown, allowed: readonly T[], path: string): T => {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
        throw new Error(`${path} must be one of: ${allowed.join(', ')}`);
    }
    return value as T;
};

const assertArray = (value: unknown, path: string): unknown[] => {
    if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array`);
    }
    return value;
};

const assertNumberArray = (value: unknown, path: string): number[] => {
    const arr = assertArray(value, path);
    for (let i = 0; i < arr.length; i++) {
        assertNumber(arr[i], `${path}[${i}]`);
    }
    return arr as number[];
};

const assertTuple3 = (value: unknown, path: string): [number, number, number] => {
    const arr = assertNumberArray(value, path);
    if (arr.length !== 3) {
        throw new Error(`${path} must have exactly 3 elements`);
    }
    return arr as [number, number, number];
};

export type { Obj };
export {
    assertObject,
    assertNumber,
    assertString,
    assertBoolean,
    assertEnum,
    assertArray,
    assertNumberArray,
    assertTuple3
};
