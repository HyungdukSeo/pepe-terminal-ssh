"""
menu.json 의 모든 라벨 값에서 선행 이모지/심볼 + 공백을 제거한다.
"""
import json, re

# 이모지/심볼/변형 셀렉터 범위
EMOJI_RE = re.compile(
    '^(?:'
    '[ -⯿]'             # 일반 심볼, 화살표, 딩벳, 미수 (ℹ ⌨ ➕ ✖ 등)
    '|[　-〿]'             # CJK 구두점
    '|[︀-️]'             # 변형 셀렉터
    '|[\U0001f000-\U0001ffff]'    # 이모지 본 범위
    ')+\\s*'
)

for lang in ['ko', 'en', 'fr', 'zh-CN', 'ar']:
    p = f'resources/i18n/{lang}/menu.json'
    d = json.load(open(p, encoding='utf-8'))
    changed = []
    for sec, kv in d.items():
        if not isinstance(kv, dict):
            continue
        for k, v in kv.items():
            if isinstance(v, str):
                new = EMOJI_RE.sub('', v).strip()
                if new != v:
                    kv[k] = new
                    changed.append(f'{sec}.{k}: "{v}" -> "{new}"')
    json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'== {lang} == {len(changed)} additional changes')
    for c in changed[:10]:
        print(f'  {c}')
