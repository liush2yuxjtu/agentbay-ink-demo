# Provider login TDD evidence

## Source and scope

- Source request: add login plus LLM Base URL/API key and Aliyun/AgentBay configuration.
- Safe interpretation: local operator credential login, not end-user authentication for the HTTP LAN app.
- Included: hidden CLI input, private files, status without values, LLM token/API-key modes, AgentBay key/region, Aliyun CLI profile, environment overrides, and existing claudex fallback.
- Excluded: browser-side secret collection, storing Aliyun AccessKey ID/Secret, paid LLM validation calls, and public-network user accounts.

## User journeys

1. As a local operator, I can run `npm run login` once and start the TUI/Web app without manually exporting secrets.
2. As a CI/container operator, I can override local files with environment variables.
3. As an operator, I can run `npm run auth:status` without exposing any credential value.
4. As an existing user, my `~/.config/claudex` fallback continues to work.

## RED → GREEN

| Stage | Evidence |
| --- | --- |
| RED | `node --import tsx --test test/auth-config.test.ts` executed 3 tests: 2 failed because `scripts/auth.sh` did not exist and `with-runtime.sh` rejected `LLM_*`; 1 existing claudex fallback check passed. |
| RED checkpoint | Local checkpoint `9064939` (`test: add provider login configuration contract`). |
| GREEN | The same command executed 3/3 tests successfully after the minimal implementation. |
| GREEN checkpoint | Local checkpoint `96312c8` (`feat: add secure provider login configuration`). |
| Full regression | `npm run check`: typecheck, 26/26 tests, and TypeScript build passed. |

Checkpoint commits may be folded before public push so key-shaped synthetic fixtures do not remain in public history; this report preserves the RED/GREEN evidence.

## Test specification

| # | Guaranteed behavior | Evidence | Type | Result |
| --- | --- | --- | --- | --- |
| 1 | Login writes configuration directories as `0700` and files as `0600` without printing either secret | `test/auth-config.test.ts` — local login test | Integration | PASS |
| 2 | Saved token-mode config maps to `ANTHROPIC_AUTH_TOKEN`; AgentBay region/profile are loaded | Same test, child runtime probe | Integration | PASS |
| 3 | `LLM_*` environment variables override files and support direct Anthropic API-key mode | Environment priority test | Integration | PASS |
| 4 | Existing CLIProxyAPI helper remains the fallback when no new LLM login exists | Fallback test | Regression | PASS |
| 5 | Invalid non-HTTP Base URL exits without writing LLM or AgentBay credential files | Invalid input test | Security | PASS |
| 6 | Claude Agent SDK receives only the selected API-key/token variable | `src/agent.ts` allowlist + runtime probes | Unit/integration | PASS |

## Coverage and security

- `npm run test:coverage`: lines **93.24%**, branches **80.68%**, functions **88.29%**.
- `test/auth-config.test.ts`: 100% line/branch/function coverage.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- Credentials are never placed in command arguments, browser storage, logs, fixtures, `.env.example`, or tracked configuration files.

## Known boundaries

- `login` validates local syntax and storage only; it does not spend tokens or create an AgentBay sandbox to prove credentials remotely.
- The LAN WebApp remains an unauthenticated trusted-LAN demo. Add TLS and real user authentication before exposing it beyond the LAN.
- Aliyun AccessKey ID/Secret remain owned by `aliyun configure`; this project stores only the optional profile name.
