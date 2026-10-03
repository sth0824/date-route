# 데이트 노선도

만날 동네를 입력하거나 "요즘 핫한 곳으로"를 누르면 Claude가 웹 검색으로 서울·경기 데이트 코스를 짜주는 작은 웹앱.

## 로컬 실행
```
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start   # http://localhost:3000
```

## 환경변수
| 이름 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | 필수. Claude API 키 |
| `ACCESS_CODE` | 선택. 설정하면 이 코드를 아는 사람만 코스 생성 가능 |
| `HOURLY_LIMIT` | 선택. IP당 시간당 요청 수 (기본 20) |
| `EFFORT` | 선택. low(기본, 빠름) / medium / high |

## 배포 (Render)
GitHub에 올린 뒤 Render → New → Blueprint → 이 저장소 선택. `render.yaml`대로 생성되고, 환경변수 입력 칸에 API 키와 입장 코드를 넣으면 끝.
