# External-source network verification

For the vendored Alibaba Cloud AgentBay skill attribution, the upstream repository was checked at:

`https://github.com/aliyun/alibabacloud-aiops-skills`

- Mainland/direct path: connection timeout after 30 seconds; no bytes downloaded.
- Authorized egress path: HTTP 200, 288,412 bytes in 1.50 seconds; SHA-256 `bcc68176e05ad2115e6a4f17d9cedc0076a9a2138df85dd7b9dddbd637a2c730`.
- Upstream README identifies the repository as Apache-2.0 overall and states individual Skills are MIT-licensed. The vendored skill preserves the MIT notice in its `NOTICE.md`.

No credential values or proxy endpoints are recorded.
