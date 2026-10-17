import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
const source = await readFile('.env','utf8');
for(const key of ['NEO4J_URI','NEO4J_USERNAME','NEO4J_PASSWORD']) if(!new RegExp('^'+key+'=.+$','m').test(source)) throw new Error('Complete '+key+' in .env first.');
const directory=path.join(homedir(),'Library','Application Support','Goal Coach');
await mkdir(directory,{recursive:true});
await writeFile(path.join(directory,'.env'),source,{mode:0o600});
console.log('Local desktop configuration installed. Credentials were not bundled with the app.');
