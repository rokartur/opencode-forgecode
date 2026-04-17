import { Database } from 'bun:sqlite'
import { unlinkSync } from 'fs'

const p = process.env.TMPDIR + 'ro-bun-' + Date.now() + '.db'
const w = new Database(p)
w.exec('CREATE TABLE t (x INT); INSERT INTO t VALUES (1);')
w.close()

const r = new Database(p, { readonly: true })
console.log('opened readonly')
try {
	r.run('PRAGMA query_only=ON')
	console.log('query_only set')
} catch (e) {
	console.log('query_only err:', (e as Error).message)
}
try {
	const s = r.prepare('INSERT INTO t VALUES (2)')
	console.log('prepared INSERT ok')
	try {
		s.run()
		console.log('RAN INSERT?!')
	} catch (e) {
		console.log('run insert err:', (e as Error).message)
	}
} catch (e) {
	console.log('prepare insert err:', (e as Error).message)
}
const s2 = r.prepare('SELECT COUNT(*) c FROM t')
console.log('SELECT', s2.get())
r.close()
unlinkSync(p)
