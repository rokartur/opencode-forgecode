import { createHash } from 'crypto'

export function hashBytesToHex(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

export function hashStringToHex(value: string): string {
	return createHash('sha256').update(value).digest('hex')
}
