declare module 'pdfmake/build/pdfmake' {
	const pdfMake: {
		virtualfs: Record<string, unknown>;
		addVirtualFileSystem(vfs: Record<string, string>): void;
		createPdf(docDefinition: unknown): {
			getBuffer(): Promise<Uint8Array>;
			getBlob(): Promise<Blob>;
			download(defaultFileName?: string): Promise<void>;
		};
	};
	export default pdfMake;
}

declare module 'pdfmake/build/vfs_fonts' {
	const vfs: Record<string, string>;
	export default vfs;
}
