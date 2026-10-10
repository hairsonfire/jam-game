import {readFileSync} from 'node:fs';
import {transpileModule, ScriptTarget, ModuleKind} from 'typescript';
import {describe,it,expect,vi} from 'vitest';

// Exercise the exact production HTTP transport without starting Deno.serve or
// requiring real Spotify/Supabase credentials in the local test runner.
const source = readFileSync('supabase/functions/spotify/index.ts','utf8');
const transport = source.slice(source.indexOf('class SpotifyError'),source.indexOf('async function exchange'));
const compiled = transpileModule(transport,{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.None}}).outputText;
function apiWith(fetcher: typeof fetch) {
  return new Function('fetch',compiled+'; return api;')(fetcher) as (token:string,path:string,method?:string)=>Promise<unknown>;
}
describe('Réponses HTTP Spotify',()=>{
  for (const method of ['POST','PUT']) for (const body of ['', 'wm-S3CJ_Fd-request-id', '{"ok":true}']) {
    it(`accepte une commande ${method} réussie avec le corps ${JSON.stringify(body)}`,async()=>{
      const response = new Response(body,{status:200});
      const parse = vi.spyOn(response,'json');
      await expect(apiWith(vi.fn().mockResolvedValue(response))('token','/me/player/queue',method)).resolves.toBeNull();
      expect(parse).not.toHaveBeenCalled();
    });
  }
  it('accepte aussi une réponse 204 vide',async()=>{
    await expect(apiWith(vi.fn().mockResolvedValue(new Response(null,{status:204})))('token','/me/player/next','POST')).resolves.toBeNull();
  });
  it('lit le JSON pour les recherches',async()=>{
    const data={tracks:{items:[]}};
    await expect(apiWith(vi.fn().mockResolvedValue(Response.json(data)))('token','/search')).resolves.toEqual(data);
  });
  it('affiche un message français si le suivi est illisible, sans exposer le corps',async()=>{
    await expect(apiWith(vi.fn().mockResolvedValue(new Response('unexpected-body')))('token','/me/player')).rejects.toThrow('Le suivi Spotify est momentanément illisible');
  });
  it('distingue un refus certain d’une commande dont la réponse a été perdue',async()=>{
    await expect(apiWith(vi.fn().mockResolvedValue(new Response('refused',{status:403})))('token','/me/player/queue','POST')).rejects.toMatchObject({status:403,uncertain:false});
    await expect(apiWith(vi.fn().mockRejectedValue(new TypeError('network')))('token','/me/player/queue','POST')).rejects.toMatchObject({status:0,uncertain:true});
    await expect(apiWith(vi.fn().mockResolvedValue(new Response('error',{status:502})))('token','/me/player/queue','POST')).rejects.toMatchObject({status:502,uncertain:true});
  });
});
