import {readFile,writeFile} from 'node:fs/promises';
const html=await readFile('prototype/index.html','utf8');
const css=await readFile('prototype/styles.css','utf8');
const core=(await readFile('prototype/core.js','utf8')).replace(/\bexport /g,'');
const app=(await readFile('prototype/app.js','utf8')).replace(/^import .*?;\n/,'');
const out=html.replace('<link rel="stylesheet" href="styles.css"><script type="module" src="app.js"></script>',`<style>${css}</style>`).replace('</body>',`<script type="module">${core}\n${app.replaceAll('</script>','<\\/script>')}</script></body>`);
await writeFile('StoryBank.html',out);console.log('Built StoryBank.html');
