"""아이콘이 없는 메뉴 항목들에 일관된 아이콘 부여."""
import json, re

NEW_ICONS = {
    'view': {
        'fontSizeUp': '🔠',
        'fontSizeDown': '🔡',
    },
    'window': {
        'splitH': '◫',  # 가로 분할 (좌/우) — 세로 구분선
        'splitV': '⊟',  # 세로 분할 (상/하) — 가로 구분선
        'clearScreen': '🧹',
    },
}

EMOJI_PREFIX = re.compile(r'^[ -⯿\U0001F000-\U0001FFFF️]+\s+')

for lang in ['ko', 'en', 'fr', 'zh-CN', 'ar']:
    p = f'resources/i18n/{lang}/menu.json'
    d = json.load(open(p, encoding='utf-8'))
    cnt = 0
    for sec, kv in NEW_ICONS.items():
        target = d.get(sec, {})
        for k, icon in kv.items():
            if k not in target:
                continue
            v = target[k]
            if not isinstance(v, str):
                continue
            # 이미 같은 아이콘이면 스킵
            if v.lstrip().startswith(icon):
                continue
            # 다른 아이콘이 이미 있다면 교체하지 않고 그대로
            if EMOJI_PREFIX.match(v):
                continue
            target[k] = f'{icon} {v}'
            cnt += 1
    json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'== {lang} == {cnt} icons added')
