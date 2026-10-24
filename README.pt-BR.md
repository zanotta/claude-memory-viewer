# claude-memory-viewer

Um visualizador local e **somente leitura** das memórias que o Claude Code guarda
em disco: seus arquivos `CLAUDE.md` e a *auto memory* de cada projeto. Ele sobe um
servidor web pequeno em `localhost` e abre uma interface de três painéis
(projetos → arquivos → conteúdo) com busca e atualização ao vivo.

> **Não oficial.** Este projeto não tem afiliação, endosso nem suporte da
> Anthropic. "Claude" e "Claude Code" são marcas de seus respectivos
> proprietários. O formato dos arquivos que ele lê não é um contrato documentado
> nem estável e pode mudar.

[English](README.md)

<!-- Espaço para screenshot: adicione docs/screenshot.png e descomente a linha abaixo.
![Claude Memory Viewer](docs/screenshot.png)
-->

## Recursos

- Navega pelo `CLAUDE.md` global, pela auto memory de cada projeto (`MEMORY.md` +
  arquivos de tópico) e pelos `CLAUDE.md`, `.claude/CLAUDE.md` e `CLAUDE.local.md`
  de cada projeto.
- Entende o índice `MEMORY.md`: sinaliza **links quebrados**, **arquivos fora do
  índice** e mostra exatamente onde começa a parte **não carregada no contexto**
  (200 linhas / 25 KB por padrão).
- Renderizador de Markdown próprio (sem HTML cru, links seguros) com alternância
  Raw / Rendered e um cartão para o frontmatter (`name`, `description`,
  `metadata`, ...).
- Busca em todo o conteúdo, sem diferenciar maiúsculas/minúsculas nem acentos
  (`configuracao` encontra `Configuração`).
- Atualização ao vivo: edite uma memória no editor, ou deixe o Claude escrever
  uma, e a página atualiza sem perder a posição de rolagem nem a seleção.
- Tema claro/escuro seguindo o sistema, navegação por teclado, layout responsivo.
- Zero dependências de runtime, nada é carregado da rede, nada é escrito em disco.

## Instalação e uso

Requer **Node.js 20 ou mais novo**.

**Com `npx`, direto do GitHub:**

```sh
npx github:zanotta/claude-memory-viewer
```

> **npm 12 ou mais novo** bloqueia pacotes buscados via git por padrão
> (`EALLOWGIT: Fetching packages of type "git" have been disabled`). Libere só para
> este comando com `npx --allow-git=all github:zanotta/claude-memory-viewer` (ou
> use o método de clonar, abaixo, que não é afetado). A primeira execução compila
> o projeto a partir do código-fonte pelo script `prepare`, o que leva alguns
> segundos.

**Ou clonando:**

```sh
git clone https://github.com/zanotta/claude-memory-viewer.git
cd claude-memory-viewer
npm install        # também compila o projeto (script "prepare")
npm start
```

O navegador abre em <http://127.0.0.1:4577/>. Use `Ctrl+C` para encerrar.

### Opções

| Flag | Descrição | Padrão |
| --- | --- | --- |
| `--port <n>` | Porta para escutar. Se estiver ocupada, tenta as 20 seguintes. `0` escolhe uma livre. | `4577` |
| `--host <addr>` | Endereço de bind. Qualquer coisa que não seja loopback exibe um aviso. | `127.0.0.1` |
| `--config-dir <dir>` | Diretório de configuração do Claude. Tem prioridade sobre `CLAUDE_CONFIG_DIR` e `~/.claude`. | veja abaixo |
| `--no-open` | Não abre o navegador. | abre |
| `--json` | Imprime o resultado do scan (só metadados, sem conteúdo de arquivos) em JSON e sai. Sem servidor. | desligado |
| `--version`, `--help` | | |

Exemplos:

```sh
npx github:zanotta/claude-memory-viewer --port 5000 --no-open
npx github:zanotta/claude-memory-viewer --config-dir /caminho/para/outro/.claude
npm start -- --json | jq '.overview.projects[] | {shortName: .shortName, files: .memoryFileCount}'
```

### Atalhos de teclado

`/` busca · `j`/`k` ou `↓`/`↑` move na lista · `h`/`l` ou `←`/`→` troca de painel ·
`r` raw/rendered · `Esc` limpa a busca.

## Onde ele procura

1. O diretório de configuração: `--config-dir`, senão `CLAUDE_CONFIG_DIR`, senão
   `~/.claude` (`%USERPROFILE%\.claude` no Windows).
2. `<config>/CLAUDE.md` — memória global.
3. `<config>/projects/<caminho-codificado>/memory/**/*.md` — auto memory. O nome da
   pasta é o caminho do projeto com todo caractere que não seja letra ou dígito
   trocado por `-`, então ele é ambíguo. O caminho real é recuperado lendo o campo
   `cwd` dos primeiros KB de uma transcrição de sessão e, se isso falhar, buscando
   no seu sistema de arquivos. Se a pasta do projeto não existe mais, a memória
   continua sendo exibida, com o selo *path not found on disk*.
4. Para projetos cuja pasta ainda existe: `CLAUDE.md`, `.claude/CLAUDE.md` e
   `CLAUDE.local.md` dentro dela (o último recebe o selo *local only*).

## O que ele **não** faz

- Nunca escreve, cria, renomeia nem apaga nada. Toda requisição que não seja
  `GET`/`HEAD` recebe `405`.
- Não faz requisições de rede de saída, não tem telemetria e não carrega fontes,
  scripts nem imagens de lugar nenhum. Imagens em Markdown não são buscadas.
- Não lê suas transcrições de sessão (`*.jsonl`) além dos primeiros kilobytes
  necessários para achar o `cwd` do projeto, e nunca as exibe.
- Não edita memórias, não compara versões e não exporta nada.

## Segurança e privacidade

Memórias podem conter informação sensível, então os padrões são conservadores:

- Escuta em `127.0.0.1`. Usar `--host` com um endereço que não seja loopback exibe
  um aviso.
- O header `Host` é validado contra os nomes de loopback e a porta real, o que
  bloqueia ataques de DNS rebinding. Requisições de navegador marcadas como
  cross-site por `Sec-Fetch-Site` são recusadas na API.
- O acesso a arquivos é por lista permitida: o id do projeto precisa ser uma pasta
  real em `projects/`, os caminhos de memória são resolvidos com `realpath` e
  precisam ficar dentro da pasta `memory/` do projeto (symlinks que escapam são
  recusados), só são servidos arquivos `.md`/`.txt` de até 2 MB, e bytes nulos são
  rejeitados. Os nomes fixos `CLAUDE.md` (global e de projeto) são a única exceção:
  podem ser symlinks, porque mantê-los em um repositório de dotfiles é comum.
- Headers de resposta rígidos: `Content-Security-Policy: default-src 'self';
  frame-ancestors 'none'` (mais `base-uri`/`form-action 'none'`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` e
  `Cache-Control: no-store` na API.
- O Markdown tem o HTML escapado antes de qualquer outra coisa; links se limitam a
  `http`, `https`, `mailto` e links `.md` internos do app.
- Os logs contêm só caminhos e contagens, nunca conteúdo de arquivos.

## Limitações conhecidas

- O formato em disco do Claude Code não é um contrato estável. Arquivos
  inesperados nunca derrubam o visualizador: geram um aviso ou são ignorados.
- A codificação do nome da pasta para `.`, `_`, espaços, caracteres não ASCII e
  caminhos do Windows, e o truncamento de nomes muito longos, seguem o
  comportamento observado e não puderam ser todos verificados com dados reais
  (veja `DECISIONS.md`).
- A janela do `MEMORY.md` (200 linhas / 25 KB) segue a documentação do Claude Code;
  ajuste as constantes em `src/memory-index.ts` se isso mudar.
- O renderizador de Markdown cobre o Markdown do dia a dia, não todo o CommonMark
  (sem HTML cru, títulos setext, blocos de código indentados, links por
  referência nem notas de rodapé).
- Mudanças nos `CLAUDE.md` dentro dos projetos são percebidas por uma checagem a
  cada 5 segundos.

## Solução de problemas

**"No Claude Code config directory found"** — a página mostra onde procurou.
Aponte para outro lugar com `--config-dir /caminho/para/.claude` ou defina
`CLAUDE_CONFIG_DIR`.

**`EALLOWGIT ... Fetching packages of type "git" have been disabled`** — o npm 12+
desabilita dependências git por padrão. Rode
`npx --allow-git=all github:zanotta/claude-memory-viewer` ou clone o repositório e
use `npm install && npm start`.

**"Port 4577 is in use"** — o visualizador já tenta as 20 portas seguintes; passe
`--port <n>` para escolher outra faixa.

**Um projeto aparece só com o nome codificado da pasta** — não foi possível
recuperar o caminho real (sem transcrição e a pasta não existe mais). A memória
dele continua listada.

**A página não atualiza** — veja o indicador no canto superior direito. Ele mostra
*reconnecting…* se o canal de eventos caiu; a página ressincroniza quando volta.

**O `npx` demora na primeira vez** — ele compila o projeto a partir do código-fonte
(`prepare`). As próximas execuções usam o cache do npm.

## Desenvolvimento

```sh
npm install
npm run build      # tsc -b + copia os estáticos para dist/
npm test           # compila os testes e roda com node:test
npm run clean
```

O TypeScript é estrito e só ESM; servidor e interface rodam em TypeScript **sem
dependências de runtime** (apenas `typescript` e `@types/node` em desenvolvimento).
Os testes rodam sobre a saída compilada com o runner nativo, usando um diretório de
configuração fictício em `test/fixtures/`. Veja [DECISIONS.md](DECISIONS.md) para
as notas de design e as descobertas.

## Contribuindo

Issues e pull requests são bem-vindos. Mantenha as mudanças sem dependências e
somente leitura, inclua testes e nunca commite memórias ou transcrições reais: as
fixtures precisam ser fictícias.

## Licença

[MIT](LICENSE)
