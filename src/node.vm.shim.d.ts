// SourceTextModule and SyntheticModule are experimental and not yet in the types.
// This declaration shim can be removed once they are added to @types/node.
declare module 'node:vm' {
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const SourceTextModule: any;

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const SyntheticModule: any;
}