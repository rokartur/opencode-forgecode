import { readFileSync } from 'node:fs'
import { hashStringToHex } from '../runtime/hash'

export function hashLine(content: string): string {
	return hashStringToHex(content).slice(0, 8)
}

export function parseAnchor(anchor: string): { line: number; hash: string } {
	const match = /^(\d+)#([0-9a-f]{8})$/i.exec(anchor.trim())
	if (!match) {
		throw new Error(`Invalid anchor format: ${anchor}`)
	}

	const line = Number.parseInt(match[1], 10)
	if (!Number.isInteger(line) || line <= 0) {
		throw new Error(`Invalid anchor line: ${anchor}`)
	}

	return {
		line,
		hash: match[2].toLowerCase(),
	}
}

export function buildAnchoredView(filePath: string): string {
	const content = readFileSync(filePath, 'utf8')
	const lines = toAnchoredLines(content)
	return lines.map((line, index) => `${index + 1}#${hashLine(line)}: ${line}`).join('\n')
}

function toAnchoredLines(content: string): string[] {
	if (content === '') return []
	const lines = content.split('\n')
	if (content.endsWith('\n')) {
		lines.pop()
	}
	return lines
}
