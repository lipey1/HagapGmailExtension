# Hagap BMDs para Gmail

Extensão Chrome (Manifest V3) que adiciona a aba **BMDs** na barra de categorias do Gmail (ao lado de Principais, Promoções, Social, Atualizações).

Ao selecionar BMDs, a extensão aplica uma busca nativa do Gmail por e-mails que:

1. Você **enviou** (`from:me`)
2. Para um **destinatário configurável** (`to:exemplo@empresa.com`)
3. Com **anexos** (`has:attachment`)
4. Com filtro de tempo (**Por dias**, **Por período** ou **Customizado**)

A barra BMDs também **aparece sozinha** quando a busca atual do Gmail contém `to:<destinatário configurado>` (mesmo sem clicar na aba). Em buscas para outro destinatário, inbox ou labels, a barra some. **Voltar** limpa a sessão BMDs; uma nova busca manual com o `to:` certo faz a barra voltar.

Paleta visual inspirada em [hagapsystems.cloud](https://hagapsystems.cloud) (`#5271FF`, `#F08716`, `#24303F`).

## Recursos

- Aba **BMDs** integrada à UI do Gmail
- Destinatário configurável (salvo em `chrome.storage`, nunca hardcoded no código)
- Filtros: **Por dias** (7 / 30 / Todos), **Por período** (Semanal / Mensal / Todos), **Customizado** (início/fim inclusivos)
- **Baixar BMDs**: permanece na lista, descobre anexos sem abrir e-mail por e-mail, gera ZIP quando há mais de um arquivo
- Progresso na barra (`Encontrando anexos…`, `Baixando…`, `Gerando ZIP…`)
- Paleta e logo Hagap

## Instalação (Load unpacked)

1. Abra o Chrome em `chrome://extensions`
2. Ative **Modo do desenvolvedor** (canto superior direito)
3. Clique em **Carregar sem compactação** / **Load unpacked**
4. Selecione a pasta deste repositório (a que contém `manifest.json`)
5. Abra o Gmail (`https://mail.google.com`) e recarregue a página se necessário

Se a extensão já estava carregada, use **Atualizar** em `chrome://extensions` após puxar mudanças (novas permissões pedem confirmação).

## Configuração

1. Clique no ícone da extensão na barra do Chrome, **ou**
2. Em `chrome://extensions` → Hagap BMDs → **Detalhes** → **Opções**

Defina o **e-mail do destinatário** (para quem você enviou os BMDs), por exemplo `exemplo@empresa.com`, e o modo de filtro padrão.

O destinatário fica só no storage local do Chrome. Não há arquivo de configuração no repositório com e-mails reais.

## Barra BMDs no Gmail

Com o filtro BMDs ativo (aba ou busca com o destinatário configurado), a barra mostra:

1. **Quem** - logo + `Enviados para <destinatário> · com anexos`
2. **Quando** - modo `Por dias` ou `Por período` (trocar o modo aplica a busca na hora com o chip atual)
3. **Ações** - **Baixar BMDs**, **Voltar**, engrenagem

| Controle | Função |
| --- | --- |
| Por dias / Por período | Troca os chips e aplica o filtro do chip selecionado (sem sumir a barra) |
| Chips de tempo | Aplicam a busca no Gmail |
| **Customizado** | Modal com data início/fim (inclusivo). Persistido em `chrome.storage`. O operador Gmail `before:` é exclusivo: a extensão usa o dia seguinte à data fim |
| **Baixar BMDs** | Fica na **lista** (não abre e-mail por e-mail). Expande **Mais…**, lê chips/`download_url`, fetch silencioso e probe `attid`. Com **mais de 1** anexo: um `BMDs-YYYY-MM-DD.zip`. Com **1**: download nativo |
| **Voltar** | Sai da busca BMDs e volta para `#inbox` |
| Engrenagem | Abre as opções |

Logs no console do DevTools: `[Hagap BMDs]`.

### Como o download funciona (visão geral)

1. A extensão permanece na **visão de lista** do Gmail (não navega thread a thread).
2. Descobre anexos a partir dos chips da lista (`download_url`), fetch same-origin autenticado e, se preciso, probe de `attid`.
3. Com vários arquivos, monta um ZIP (JSZip) e dispara o download via API Chrome Downloads.
4. Com um único anexo, usa download nativo.

### Limitações

- Não usa Gmail API / OAuth.
- Cobre a **página de resultados visível** (role no Gmail se precisar de mais linhas).
- Depende do HTML/endpoints internos do Gmail (podem mudar).
- Nomes colidentes no ZIP recebem prefixo `01_`, `02_`, … e sufixo se ainda houver conflito.

## Filtros (operadores Gmail)

| Controle | Opção | Operador Gmail |
| --- | --- | --- |
| Base | sempre | `from:me to:<destinatário> has:attachment` |
| Por dias | 7 / 30 / Todos | `newer_than:7d` / `newer_than:30d` / (sem data) |
| Por período | Semanal / Mensal / Todos | `after:` segunda / dia 1 / (sem data) |
| Por período | Customizado | `after:AAAA/MM/DD before:AAAA/MM/DD` (fim inclusivo via `before` = fim+1 dia) |

## Permissões

| Permissão | Por quê |
| --- | --- |
| `storage` | Salvar destinatário, modo de filtro e período customizado |
| `downloads` / `downloads.ui` / `downloads.shelf` | Baixar anexos e o ZIP gerado |
| `offscreen` | Montar blob/URL do ZIP fora do service worker quando necessário |
| `https://mail.google.com/*` | Injetar a aba/barra e ler a lista |
| `https://*.googleusercontent.com/*` e anexos | Fetch dos arquivos de anexo com a sessão do Google |

A extensão **não** envia seus dados para servidores Hagap. Tudo roda localmente no Chrome + Gmail.

## Estrutura

```text
HagapGmailExtension/
├── manifest.json
├── README.md
├── LICENSE
├── icons/                 # ícones e logo (seguros para o repo)
└── src/
    ├── background.js      # service worker (downloads, storage, offscreen)
    ├── content.js         # aba, barra, filtros, Baixar BMDs
    ├── content.css
    ├── offscreen.html|js
    ├── vendor/jszip.min.js
    ├── popup.html|css|js
    └── options.html|css|js
```

Versão atual: ver `manifest.json` (ex.: `1.6.7`).

## Screenshots

Adicione capturas locais (opcional) em `docs/screenshots/` se quiser documentar a UI:

- `docs/screenshots/aba-bmds.png` - aba BMDs no Gmail
- `docs/screenshots/barra-filtros.png` - barra com chips e Baixar BMDs
- `docs/screenshots/opcoes.png` - tela de opções / destinatário

*(Pasta vazia de propósito; não versionamos e-mails reais nas imagens.)*

## Desenvolvimento

1. Edite os arquivos em `src/`
2. Em `chrome://extensions`, clique em **Atualizar** na extensão
3. Recarregue o Gmail

Não commite `.env`, perfis Chrome, ZIPs de BMDs baixados, nem e-mails reais de destinatário.

## Licença

MIT. Veja [LICENSE](LICENSE).
