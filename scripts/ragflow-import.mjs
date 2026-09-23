// Explicit local account binding; never infer ownership from the first database user.
import { getDatabase } from '../lib/db/index.ts';
import { importRagflowDocument } from '../lib/knowledge/ragflow-import.ts';
const [username, datasetId, documentId] = process.argv.slice(2);
if (!username || !datasetId || !documentId) throw new Error('Usage: node --env-file=.env.local --experimental-strip-types scripts/ragflow-import.mjs USERNAME DATASET_ID DOCUMENT_ID');
const user = getDatabase().prepare('SELECT id FROM users WHERE username = ?').get(username);
if (!user) throw new Error('学习助手账号不存在。');
console.log(await importRagflowDocument(user.id, datasetId, documentId));
