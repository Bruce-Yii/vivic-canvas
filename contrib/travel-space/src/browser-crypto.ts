// The shared offline provider uses only randomUUID; no Node service code is exposed.
export const randomUUID = () => crypto.randomUUID();
