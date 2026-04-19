/**
 * Harness Plugin Loader — discovers and loads harness plugins from
 * configured module specifiers.
 *
 * Plugins are specified in `config.harness.plugins` as an array of:
 *   - Relative paths (resolved from project root)
 *   - Package names (resolved via standard module resolution)
 *
 * Each module must export a `HarnessPlugin`-conformant object as the default
 * export or as a named `plugin` export.
 */

import type { HarnessPlugin } from './plugin-api'
import type { Logger } from '../types'

export interface PluginLoadResult {
	loaded: HarnessPlugin[]
	errors: Array<{ specifier: string; error: string }>
}

/**
 * Load all harness plugins from the given specifiers.
 * Failures are collected but do not halt loading — each plugin is isolated.
 */
export async function loadHarnessPlugins(
	specifiers: string[],
	projectDir: string,
	logger: Logger,
): Promise<PluginLoadResult> {
	const loaded: HarnessPlugin[] = []
	const errors: Array<{ specifier: string; error: string }> = []

	for (const specifier of specifiers) {
		try {
			const resolved = resolveSpecifier(specifier, projectDir)
			const mod = await import(resolved)
			const plugin = extractPlugin(mod)

			if (!plugin) {
				errors.push({
					specifier,
					error: 'Module does not export a valid HarnessPlugin (no default or named `plugin` export with `name` field).',
				})
				continue
			}

			validatePlugin(plugin)
			loaded.push(plugin)
			logger.log(`[harness-plugin] Loaded plugin: ${plugin.name} (from ${specifier})`)
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			errors.push({ specifier, error: msg })
			logger.log(`[harness-plugin] Failed to load plugin from ${specifier}: ${msg}`)
		}
	}

	return { loaded, errors }
}

/**
 * Resolve a plugin specifier to an importable path.
 * Relative paths are resolved against the project directory.
 */
function resolveSpecifier(specifier: string, projectDir: string): string {
	if (specifier.startsWith('.') || specifier.startsWith('/')) {
		// Relative or absolute path — resolve from project dir
		const { resolve } = require('path') as typeof import('path')
		return resolve(projectDir, specifier)
	}
	// Package name — let the runtime resolve it
	return specifier
}

/**
 * Extract a HarnessPlugin from a module's exports.
 * Checks default export first, then named `plugin` export.
 */
function extractPlugin(mod: Record<string, unknown>): HarnessPlugin | null {
	// Default export
	const def = mod.default as Record<string, unknown> | undefined
	if (def && typeof def.name === 'string') {
		return def as unknown as HarnessPlugin
	}

	// Named `plugin` export
	const named = mod.plugin as Record<string, unknown> | undefined
	if (named && typeof named.name === 'string') {
		return named as unknown as HarnessPlugin
	}

	return null
}

/**
 * Validate that a plugin conforms to the HarnessPlugin shape.
 * Throws on structural violations (missing required fields).
 */
function validatePlugin(plugin: HarnessPlugin): void {
	if (!plugin.name || typeof plugin.name !== 'string') {
		throw new Error('HarnessPlugin must have a `name` string field.')
	}

	if (plugin.detectors) {
		for (const d of plugin.detectors) {
			if (!d.name || typeof d.detect !== 'function') {
				throw new Error(`Detector in plugin '${plugin.name}' must have a 'name' and 'detect' function.`)
			}
		}
	}

	if (plugin.truncators) {
		for (const t of plugin.truncators) {
			if (!t.name || typeof t.truncate !== 'function') {
				throw new Error(`Truncator in plugin '${plugin.name}' must have a 'name' and 'truncate' function.`)
			}
		}
	}

	if (plugin.snapshots) {
		for (const s of plugin.snapshots) {
			if (!s.name || typeof s.capture !== 'function' || typeof s.restore !== 'function') {
				throw new Error(
					`Snapshot provider in plugin '${plugin.name}' must have 'name', 'capture', and 'restore'.`,
				)
			}
		}
	}
}

/**
 * HarnessPluginRegistry — in-memory registry of loaded plugins.
 * Provides convenient accessors for all detectors, truncators, and snapshots.
 */
export class HarnessPluginRegistry {
	private plugins: HarnessPlugin[] = []

	register(plugin: HarnessPlugin): void {
		if (this.plugins.some(p => p.name === plugin.name)) return
		this.plugins.push(plugin)
	}

	registerAll(plugins: HarnessPlugin[]): void {
		for (const p of plugins) {
			this.register(p)
		}
	}

	/** All detectors from all registered plugins, in registration order. */
	get detectors() {
		return this.plugins.flatMap(p => p.detectors ?? [])
	}

	/** All truncators from all registered plugins, in registration order. */
	get truncators() {
		return this.plugins.flatMap(p => p.truncators ?? [])
	}

	/** All snapshot providers from all registered plugins, in registration order. */
	get snapshotProviders() {
		return this.plugins.flatMap(p => p.snapshots ?? [])
	}

	/** Names of all loaded plugins. */
	get names(): string[] {
		return this.plugins.map(p => p.name)
	}

	get count(): number {
		return this.plugins.length
	}
}
