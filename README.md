# OGFN local backend — build-specific development base

Backend original em Node.js/Express, com GraphQL, contas OAuth locais, perfis Athena, news, loja configurável, lobby de espera/party e integração HTTP com um adaptador de GameServer.

**Uso autorizado e builds que você possui.** Este projeto não inclui arquivos do Fortnite, launcher, bypass de anticheat, certificados, proxy de interceptação nem autenticação Epic. Não conecte contas Epic reais nem credenciais reutilizadas. O OAuth aqui é local e não autentica com a Epic.

## Limite técnico importante

`npm start` inicia dois processos HTTP locais: backend em `5595` e **adaptador de desenvolvimento** em `7777`. Com `matchmaking.minPlayers: 1` (padrão), o primeiro pedido pode fechar uma sessão sozinho; aumente esse valor para exigir um mínimo de jogadores. Uma party usa uma sessão comum; pedidos solo quase simultâneos são agrupados durante `matchFillWindowMilliseconds`. O serviço na porta 7777 valida ticket assinado e registra sessões/join; **não é um GameServer Unreal de Fortnite**, não implementa gameplay, transporte/protocolos binários, replicação de mundo, travessia de rede, XMPP/STARTTLS nem negociação específica de build. A partida só é jogável quando se integra um GS compatível com a build e se substitui o adaptador por essa integração. As APIs Fortnite variam por versão (1.7/1.8/1.10 são diferentes de versões posteriores); nenhum código genérico garante que um cliente antigo entenda esses payloads.

## Requisitos

- Node.js 20 ou posterior.
- Portas TCP `5595` e `7777` livres.

## Instalação e inicialização

Na pasta `ogfn-backend`:

```bash
npm install
cp .env.example .env
```

Edite `.env` antes de expor a rede. Troque `OAUTH_CLIENT_SECRET`, `GS_INTERNAL_SECRET` e `SESSION_KEY` por valores aleatórios, únicos, com pelo menos 32 bytes. Para iniciar backend **e o adaptador GS de desenvolvimento**:

```bash
npm start
```

Para iniciar apenas o backend (use quando integrar seu GS real em `7777`):

```bash
npm run start:backend
```

Para executar somente o adaptador didático de 7777:

```bash
npm run start:gameserver
```

Não execute `npm start` e `npm run start:gameserver` juntos, pois tentarão ocupar a mesma porta 7777.

Health checks:

```bash
curl http://127.0.0.1:5595/health
curl http://127.0.0.1:7777/health
```

## Conta, OAuth e fluxo do launcher local

1. Crie a conta local (`displayName` aceita 3-16 caracteres alfanuméricos, `_` ou `-`; senha 10+ caracteres):

```bash
curl -sS http://127.0.0.1:5595/api/accounts \
  -H 'content-type: application/json' \
  -d '{"email":"player@local.test","displayName":"OGPlayer","password":"local-only-password"}'
```

2. Launcher de desenvolvimento pode trocar username/senha por token (grant legado/local; desligável com `allowPasswordGrant:false`):

```bash
curl -sS http://127.0.0.1:5595/account/api/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -u 'ogfn-local-launcher:change-this-development-secret' \
  --data-urlencode 'grant_type=password' \
  --data-urlencode 'username=player@local.test' \
  --data-urlencode 'password=local-only-password'
```

3. Para clientes que requerem OAuth authorization-code, abra no browser a rota abaixo, autentique no formulário local, leia `code` no callback e troque-o por token em `/account/api/oauth/token` com `grant_type=authorization_code`, o mesmo `redirect_uri` e `code_verifier` se PKCE foi usado. Redirect URIs permitidos estão em `oauth.redirectUris` no `config/config.json`.
4. O bearer pode usar `grant_type=refresh_token`, `exchange_code` (o access token obtém código de curta duração em `GET /account/api/oauth/exchange`) ou `device_auth` (crie com `POST /account/api/oauth/deviceAuth`). Tokens/códigos são armazenados como hashes, são de uso único quando aplicável e expirados são removidos periodicamente.

Exemplo de URL de autorização local (codifique `redirect_uri`):

```
http://127.0.0.1:5595/account/api/oauth/authorize?client_id=ogfn-local-launcher&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&scope=basic_profile&state=launcher-state
```

Esta implementação simplificada não pretende reproduzir a infraestrutura OAuth/launcher proprietária da Epic nem todos os grants históricos. O client secret local de desenvolvimento deve ser alterado.

## Endpoints principais

- `GET /health` — disponibilidade e modo de armazenamento.
- `POST /api/accounts` — cria conta local e perfis.
- `/account/api/oauth/*` — autorização, token, verify, revoke, exchange e device auth.
- `POST /fortnite/api/game/v2/profile/:accountId/client/:operation?profileId=athena` — MCP/ações de perfil (QueryProfile, SetCosmeticLockerSlot, MarkItemSeen, SetItemFavoriteStatus e PurchaseCatalogEntry).
- `GET /fortnite/api/storefront/v2/catalog` e `POST /api/shop/purchase` — catálogo/compra local.
- `/fortnite/api/v2/fortnite/br-news`, `/fortnite/api/v2/fortnite/stw-news` — news.
- `GET/POST /api/lobby`, `/party/api/v1/Fortnite/*` — party/lobby local; convites só valem 10 min.
- `POST /api/matchmaking/queue` `{ "playlist":"Playlist_DefaultSolo", "region":"EU" }`, `GET/DELETE /api/matchmaking/queue` — fila (quando há party, o líder envia o grupo inteiro); conexão de status em `ws://127.0.0.1:5595/matchmaker/ws?access_token=TOKEN` (troque TOKEN pelo access token, sem colchetes).
- `GET /fortnite/api/matchmaking/session/:sessionId` e `POST /fortnite/api/matchmaking/session/:sessionId/join` — sessão/ticket assinado.
- `POST /graphql` — GraphQL. Exemplo: `{ me { id displayName } shopOffers { offerId title price } }`.
- Save the World: playlist que contenha `stw`, `campaign` ou `save the world` recebe HTTP 403 legível; perfis `campaign` / `theater` respondem `SaveTheWorldAccessRequired`. Não lança exceção não tratada nem concede acesso.

Quase todas as rotas `account`, `profile`, `party`, `shop balance/purchase` e `matchmaking` exigem `Authorization: Bearer <access_token>`. Conteúdo público de notícias/loja não exige token.

## Perfil inicial

Cada conta recebe um perfil Athena com **três itens cosméticos**, e só três: `AthenaPickaxe:DefaultPickaxe`, `AthenaGlider:DefaultGlider`, `AthenaDance:EID_DanceMoves`. Inclui `sandbox_loadout` para referenciar esses itens e um character loadout vazio. O perfil `common_core` recebe 1000 V-Bucks locais por conveniência de teste (configurável em `store.startingVbucks`); isso é moeda fictícia, sem compra real e não adiciona cosméticos ao Athena.

## Configuração

- `config/config.json`: portas, credenciais de desenvolvimento, limites, cliente OAuth, redirects e fila.
- `.env`: overrides de deploy (copie de `.env.example`, nunca comite secrets).
- `config/news.json`: textos/assets/banner (campo `banners`).
- `config/shop.json`: ofertas e grants; item precisa usar template ID no formato `tipo:id`.
- `data/state.json`: contas, hashes, tokens, perfis, compras e partidas; escrita serializada, arquivo temporário + rename. O JSON é para protótipo de processo único; hoje a fila de sessão/party fica em memória. Faça backups e não edite enquanto servidor está ativo. Para múltiplas instâncias, migre o estado persistido para SQLite/Postgres e use locks/transações, além de um broker compartilhado para presença/fila.

## Teste

```bash
npm test
npm run check
```

## Prioridades seguintes

1. Validar payloads contra o **build exato** (incluindo account service, MCP revisions/commands, respostas de storefront/news e parsing no cliente).
2. Integrar/adaptar GS Unreal legítimo compatível com essa build, protocolo real do jogo, alocação/health/heartbeat, autenticação server-to-backend e deployments públicos; porta 7777 aqui é somente mock HTTP.
3. Implementar social de produção (XMPP/TCP/TLS conforme a build, presença/friends/invites, reconexão e party state distribuído).
4. Migrar JSON para SQLite com schema, migrations, transações, índices, backup/restore e locking.
5. Hardening: secrets e session keys por ambiente, rate limits distribuídos, HTTPS, proteção CSRF da página de login, auditoria, revogação global e persistente de access tokens, logs redigidos e observabilidade.
6. Adicionar suites de compatibilidade com fixtures de cliente para builds escolhidas e testes de carga.

## Referências consultadas

A arquitetura foi usada como inspiração de alto nível; **nenhum arquivo de código foi copiado**. As referências têm escopos/licenças/compatibilidades próprias; consulte as licenças antes de reutilizar qualquer trecho delas.

- [LawinServer](https://github.com/Lawin0129/LawinServer) — módulos de API em Node, perfis/config e matchmaking com destino GS.
- [AthenaOG](https://github.com/Ducki67/AthenaOG) — Node + Express, dados JSON, OAuth, MCP, news/shop e matchmaking para builds 1.7.2–1.10.
- [NeoniteV2](https://github.com/NeoniteDev/NeoniteV2) — emulador/lobby Node e formato de referência para locker Athena.
- [LawinServerV2](https://github.com/Lawin0129/LawinServerV2) — Node.js, rotas/modelos/token manager, account system, matchmaking e XMPP; o README especifica partidas/party e chat por versões 3.5–14.50 e informa que não suporta Save the World.
- [Fortnite endpoint documentation](https://github.com/LeleDerGrasshalmi/FortniteEndpointsDocumentation) — documentação comunitária de endpoints e operações de perfil.
- `VaxServer`, `SkyeBackend` e `NeoBackend` com esses nomes não foram confirmados como projetos/repositórios verificáveis na busca rápida.

Este projeto é comunitário, não afiliado nem endossado pela Epic Games. Observe a licença e os termos aplicáveis a builds, contas, marcas, cosméticos e serviços.

### Estrutura entregue

```text
ogfn-backend/
├── .env.example
├── .gitignore
├── README.md
├── package.json
├── package-lock.json
├── config/
│   ├── config.json
│   ├── news.json
│   └── shop.json
├── data/                 # state.json criado localmente na primeira execução
├── src/
│   ├── auth.js
│   ├── config.js
│   ├── gameserver-only.js
│   ├── gameserver.js
│   ├── graphql.js
│   ├── index.js
│   ├── lobby.js
│   ├── matchmaker.js
│   ├── news.js
│   ├── profile.js
│   ├── server.js
│   └── store.js
└── test/
    └── backend.test.js
```
