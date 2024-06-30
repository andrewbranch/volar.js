import type { FileSystem, FileType } from '@volar/language-service';
import type { URI } from 'vscode-uri';

const textCache = new Map<string, Promise<string | undefined>>();
const jsonCache = new Map<string, Promise<any>>();

export function createJsDelivrNpmFileSystem(
	getCdnPath = (uri: URI): string | undefined => {
		if (uri.path === '/node_modules') {
			return '';
		}
		else if (uri.path.startsWith('/node_modules/')) {
			return uri.path.slice('/node_modules'.length);
		}
	},
	getPackageVersion?: (pkgName: string) => string | undefined,
	onFetch?: (path: string, content: string) => void
): FileSystem {
	const fetchResults = new Map<string, Promise<string | undefined>>();
	const flatResults = new Map<string, Promise<{
		name: string;
		size: number;
		time: string;
		hash: string;
	}[]>>();

	return {
		async stat(uri) {
			const path = getCdnPath(uri);
			if (path === undefined) {
				return;
			}
			if (path === '') {
				return {
					type: 2 satisfies FileType.Directory,
					size: -1,
					ctime: -1,
					mtime: -1,
				};
			}
			return await _stat(path);
		},
		async readFile(uri) {
			const path = getCdnPath(uri);
			if (path === undefined) {
				return;
			}
			return await _readFile(path);
		},
		readDirectory(uri) {
			const path = getCdnPath(uri);
			if (path === undefined) {
				return [];
			}
			return _readDirectory(path);
		},
	};

	async function _stat(path: string) {

		const resolved = resolvePackageName(path);
		if (!resolved || !await isValidPackageName(resolved[1])) {
			return;
		}

		if (!flatResults.has(resolved[0])) {
			flatResults.set(resolved[0], flat(resolved[1], resolved[2]));
		}

		const flatResult = await flatResults.get(resolved[0])!;
		const filePath = path.slice(resolved[0].length);
		const file = flatResult.find(file => file.name === filePath);
		if (file) {
			return {
				type: 1 satisfies FileType.File,
				ctime: new Date(file.time).valueOf(),
				mtime: new Date(file.time).valueOf(),
				size: file.size,
			};
		}
		else if (flatResult.some(file => file.name.startsWith(filePath + '/'))) {
			return {
				type: 2 satisfies FileType.Directory,
				ctime: -1,
				mtime: -1,
				size: -1,
			};
		}
	}

	async function _readDirectory(path: string): Promise<[string, FileType][]> {

		const resolved = resolvePackageName(path);
		if (!resolved || !await isValidPackageName(resolved[1])) {
			return [];
		}

		if (!flatResults.has(resolved[0])) {
			flatResults.set(resolved[0], flat(resolved[1], resolved[2]));
		}

		const flatResult = await flatResults.get(resolved[0])!;
		const dirPath = path.slice(resolved[0].length);
		const files = flatResult
			.filter(f => f.name.substring(0, f.name.lastIndexOf('/')) === dirPath)
			.map(f => f.name.slice(dirPath.length + 1));
		const dirs = flatResult
			.filter(f => f.name.startsWith(dirPath + '/') && f.name.substring(dirPath.length + 1).split('/').length >= 2)
			.map(f => f.name.slice(dirPath.length + 1).split('/')[0]);

		return [
			...files.map<[string, FileType]>(f => [f, 1 satisfies FileType.File]),
			...[...new Set(dirs)].map<[string, FileType]>(f => [f, 2 satisfies FileType.Directory]),
		];
	}

	async function _readFile(path: string): Promise<string | undefined> {

		const resolved = resolvePackageName(path);
		if (!resolved || !await isValidPackageName(resolved[1])) {
			return;
		}

		if (!fetchResults.has(path)) {
			fetchResults.set(path, (async () => {
				if ((await _stat(path))?.type !== 1 satisfies FileType.File) {
					return;
				}
				const text = await fetchText(`https://cdn.jsdelivr.net/npm/${path}`);
				if (text !== undefined) {
					onFetch?.(path, text);
				}
				return text;
			})());
		}

		return await fetchResults.get(path)!;
	}

	async function flat(pkgName: string, version: string | undefined) {
		version ??= 'latest';

		// resolve latest tag
		if (version === 'latest') {
			const data = await fetchJson<{ version: string | null; }>(`https://data.jsdelivr.com/v1/package/resolve/npm/${pkgName}@${version}`);
			if (!data?.version) {
				return [];
			}
			version = data.version;
		}

		const flat = await fetchJson<{
			files: {
				name: string;
				size: number;
				time: string;
				hash: string;
			}[];
		}>(`https://data.jsdelivr.com/v1/package/npm/${pkgName}@${version}/flat`);
		if (!flat) {
			return [];
		}

		return flat.files;
	}

	async function isValidPackageName(pkgName: string) {
		// ignore @aaa/node_modules
		if (pkgName.endsWith('/node_modules')) {
			return false;
		}
		// hard code for known invalid package
		if (pkgName.startsWith('@typescript/') || pkgName.startsWith('@types/typescript__')) {
			return false;
		}
		// don't check @types if original package already having types
		if (pkgName.startsWith('@types/')) {
			let originalPkgName = pkgName.slice('@types/'.length);
			if (originalPkgName.indexOf('__') >= 0) {
				originalPkgName = '@' + originalPkgName.replace('__', '/');
			}
			const packageJson = await _readFile(`${originalPkgName}/package.json`);
			if (packageJson) {
				const packageJsonObj = JSON.parse(packageJson);
				if (packageJsonObj.types || packageJsonObj.typings) {
					return false;
				}
				const indexDts = await _stat(`${originalPkgName}/index.d.ts`);
				if (indexDts?.type === 1 satisfies FileType.File) {
					return false;
				}
			}
		}
		return true;
	}

	/**
	 * @example
	 * "a/b/c" -> "a"
	 * "@a/b/c" -> "@a/b"
	 * "@a/b@1.2.3/c" -> "@a/b@1.2.3"
	 */
	function resolvePackageName(path: string): [
		modName: string,
		pkgName: string,
		version: string | undefined,
	] | undefined {
		const parts = path.split('/');
		let modName = parts[0];
		if (modName.startsWith('@')) {
			if (!parts[1]) {
				return;
			}
			modName += '/' + parts[1];
		}
		let pkgName = modName;
		let version: string | undefined;
		if (modName.lastIndexOf('@') >= 1) {
			pkgName = modName.substring(0, modName.lastIndexOf('@'));
			version = modName.substring(modName.lastIndexOf('@') + 1);
		}
		if (!version && getPackageVersion) {
			getPackageVersion?.(pkgName);
		}
		return [modName, pkgName, version];
	}
}

async function fetchText(url: string) {
	if (!textCache.has(url)) {
		textCache.set(url, (async () => {
			try {
				const res = await fetch(url);
				if (res.status === 200) {
					return await res.text();
				}
			} catch {
				// ignore
			}
		})());
	}
	return await textCache.get(url)!;
}

async function fetchJson<T>(url: string) {
	if (!jsonCache.has(url)) {
		jsonCache.set(url, (async () => {
			try {
				const res = await fetch(url);
				if (res.status === 200) {
					return await res.json();
				}
			} catch {
				// ignore
			}
		})());
	}
	return await jsonCache.get(url)! as T;
}
