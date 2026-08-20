# OzScan 데이터 프로파일 (2026-08-19 실측)

> 외부 AI/어드바이저 공유용. Railway Postgres 실측 쿼리 결과이며, 전체 백업은
> `~/OzScan/backups/ozscan_full_20260819.dump` (282MB, pg_dump -Fc)로 로컬 보존됨.
> 용도: "실행비용 보정 CLV 엣지가 존재하는가" 백테스트의 원료 평가.

## 총괄

| 테이블 | 행 수 | 기간 | 비고 |
|---|---|---|---|
| whale_trades | 2,882,234 | **2024-01-12 ~ 2026-04-19** (2.3년) | 마켓 103,575개, 지갑 866개 |
| smart_alerts | 696,761 | 2024-10-17 ~ 2026-04-19 | 추적 지갑 63개, 마켓 19,038개 |
| odds_snapshots | 1,120,097 | **2026-03-17 ~ 2026-04-19 (약 1개월만)** | 마켓 121개, 일평균 ~34,000행 (≈5분 간격×상위 100마켓) |
| smart_profiles | 64 | — | profit 컬럼 전부 0 (미동기화), source: leaderboard 28 / monthly 16 / alltime 16 / both 4 |
| DB 크기 | 1.9GB | | 수집 중단: 2026-04-19 (서비스 크래시) |

## 스키마

```
whale_trades(id, trade_id, market, side[YES/NO], size, price, timestamp[epoch],
             created_at, proxy_wallet, resolved[bool], won[bool], final_price,
             condition_id, slug)
smart_alerts(id, trade_id, address, market, side, size, price, condition_id,
             slug, event_slug, timestamp, created_at)
odds_snapshots(id, market_id, question, price, recorded_at)
smart_profiles(address, profit, last_synced, source)
```

## 품질 실측 (중요 — 좋은 것과 나쁜 것)

**강점**
- whale_trades의 폭: 2.3년, 10만+ 마켓, 총 거래대금 표기 합계 ~$1.39B 상당. 지갑 주소(proxy_wallet)와 진입가(price, 센트 단위)가 트레이드 단위로 붙어 있음.
- smart_alerts: 리더보드 기반 63개 지갑의 22개월 활동 이력. **[8/19 저녁 시간계보 감사 완료 — 3단 구성 확정]** ① **초기 백필 배치 16,611행**: 2026-04-01 삽입, 거래시각 2024-10-17~2026-04-01 (created_at은 삽입시각 그대로 = 백데이트 없음, lag 최대 ~1.5년으로 자명하게 식별·제외 가능). ② **실시간 수집 윈도우 680,150행 (2026-04-02~04-19)**: 일별 삽입분이 당일 거래만 커버, **lag<5분이 99.95%** (5분~1시간 116행, >1시간 209행 — 다운타임 후 갭필). ③ 8/19 워커 재가동 캐치업 683행(4/13~8/19 거래, 비실시간). **결론: created_at은 신뢰 가능한 관찰시각(observed_at)이며, `lag<5분` 필터 하나로 실시간 신호만 분리 가능. 실행가능성 CLV는 ②구간(4/2~4/19)만 사용.** 이 실시간성 기록이 이 데이터셋의 최대 자산(공개 API로 재현 불가). (기존 "파일럿 윈도우 3/17~" 표기는 odds_snapshots 시작일과 혼동 — smart_alerts 실시간 시작은 4/2.)
- ~~side는 YES/NO로 일관~~ **[8/19 정정] side 컬럼은 신뢰 불가**: 수집 코드가 `(a.outcome || a.side || a.type)`로 저장 + `BUY→YES, SELL→NO` 자의 변환까지 있어 저장값이 outcome도 action도 아닌 오염 혼합. **방향(BUY/SELL)·결과토큰(YES/NO)·asset_id는 trade_id(txHash)로 API 재조회해 복원 필수.**

**약점 (백테스트 설계에 직접 영향)**
1. **odds_snapshots가 1개월×121마켓뿐** (2026-03-17~04-19). 5분 간격 가격 경로가 있어야 "진입 후 30초/5분/1시간 CLV"를 계산하는데, 이 교집합 구간이 전체 데이터의 극히 일부. → **자체 데이터만으로는 CLV 백테스트가 '2026년 3~4월 한 달' 윈도우로 제한됨.**
2. **resolution 라벨이 2.3%뿐**: resolved=true가 64,934행(전체 288만 중). resolution backfill이 거의 안 돌았음. 승패 기반 분석은 이 부분집합으로만 가능.
3. **whale_trades는 이름과 달리 고래 전용이 아님**: size 중앙값 ~$10.7. $2K 필터 수집 + 지갑 활동 백필(소액 포함)이 섞여 있음. "고래" 분석 시 size 필터 재적용 필요.
4. timestamp 오염 4만 행(epoch < 1e9) — 제외 처리 필요.
5. smart_profiles.profit 전부 0 — 지갑 메타데이터는 주소·출처뿐.
6. 2026-04-19 ~ 2026-08-19 4개월 공백 확정. **[8/19 21시 워커 재가동 완료]** — 크래시 원인은 checkResolvedTrades의 무제한 SELECT(미해결 281만 행 전량 메모리 적재→OOM), LIMIT 50으로 수정 후 재배포. 이후 신규 수집분은 다시 실시간 신호.

## 이 데이터로 지금 가능한 분석 vs 불가능한 분석

**가능**
- 2026-03-17~04-19 윈도우에서: smart_alerts/whale_trades 진입 → odds_snapshots 5분 가격 경로 대비 **5분/30분/1시간/24시간 CLV** (30초 감쇠는 불가 — 스냅샷이 5분 간격).
- 63개 추적 지갑의 22개월 진입 타이밍 패턴, 마켓 카테고리 분포(slug 파싱), 사이징 분포.
- resolved 6.5만 건 부분집합으로 승률·수익 근사(단, favorite-longshot bias 보정 필수).

**불가능(자체 데이터만으로)**
- 30초 단위 알파 감쇠, 1개월 윈도우 밖의 CLV, 호가 깊이/슬리피지(오더북 스냅샷 없음 — copyable size 계산엔 별도 수집 필요).

## 보강 경로 (백테스트 신뢰도 확보용)

- Polymarket 공개 API(clob prices-history / gamma)는 **과거 가격 시계열과 resolution을 소급 조회 가능** → whale_trades 2.3년치에 대해 가격 경로·resolution을 사후 백필하면 CLV 백테스트 윈도우를 한 달 → 2년+로 확장 가능. (이 백필 스크립트가 9/2 이후 검증 작업의 사실상 1단계)
- 오더북 깊이는 소급 불가 — "copyable size/슬리피지"는 재수집 시점부터만.

## 결론 (한 줄)

**"진입 이력"은 2.3년치로 풍부하지만 "가격 경로"가 1개월뿐이라, 자체 데이터만으론 파일럿 CLV 검증(3~4월 윈도우)까지만 가능하고, 본검증은 Polymarket API 백필이 전제다.** 데이터 자산 가치: 지갑×진입시점×진입가 원장으로서는 유효, 단독 완결 백테스트 셋으로는 불완전.
