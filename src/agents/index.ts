import type { AgentRole, AgentDefinition } from './types'
import { forgeAgent } from './forge'
import { museAgent } from './muse'
import { sageAgent } from './sage'
import { librarianAgent } from './librarian'
import { exploreAgent } from './explore'
import { oracleAgent } from './oracle'
import { prometheusAgent } from './prometheus'
import { metisAgent } from './metis'

export const agents: Record<AgentRole, AgentDefinition> = {
	forge: forgeAgent,
	muse: museAgent,
	sage: sageAgent,
	librarian: librarianAgent,
	explore: exploreAgent,
	oracle: oracleAgent,
	prometheus: prometheusAgent,
	metis: metisAgent,
}

export { type AgentRole, type AgentDefinition, type AgentConfig } from './types'
