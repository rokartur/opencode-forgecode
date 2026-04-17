import { readFileSync } from 'fs'

const BUILD_VERSION = '__FORGECODE_VERSION_VALUE__'

function readPackageVersion(): string {
	try {
		const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
			version?: string
		}
		return packageJson.version ?? BUILD_VERSION
	} catch {
		return BUILD_VERSION
	}
}

export const VERSION: string = BUILD_VERSION === '__FORGECODE_VERSION_VALUE__' ? readPackageVersion() : BUILD_VERSION
