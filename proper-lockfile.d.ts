declare module "proper-lockfile" {
	const lockfile: {
		lock(
			directory: string,
			options?: { realpath?: boolean; retries?: { retries: number; minTimeout: number; maxTimeout: number } },
		): Promise<() => Promise<void>>;
	};
	export default lockfile;
}
