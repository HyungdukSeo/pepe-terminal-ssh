"""모든 언어의 menu.json 항목 앞에 일관된 아이콘 prefix 부착."""
import json

ICONS = {
    'file': {
        'newWorkspace': '➕',
        'closeWorkspace': '✖',
        'exportSessions': '📤',
        'importSessions': '📥',
        'quit': '🚪',
    },
    'edit': {
        'copy': '📋',
        'paste': '📎',
        'selectAll': '🔘',
        'find': '🔍',
    },
    'view': {
        'theme': '🎨',
    },
    'window': {
        'clearScrollback': '🗑',
        'clearAll': '🧼',
    },
    'tools': {
        'fileTransfer': '📁',
        'browserWs': '🌐',
        'compareWs': '🔍',
        'logAnalyzerWs': '📈',
        'vpnWs': '🔒',
        'i18nWs': '🌍',
        'toolbarShow': '🧰', 'toolbarHide': '🧰',
        'quickConnectShow': '⚡', 'quickConnectHide': '⚡',
        'claudeShow': '🤖', 'claudeHide': '🤖',
        'broadcastShow': '📢', 'broadcastHide': '📢',
        'xStart': '🖥️', 'xStop': '🛑', 'xStatus': 'ℹ️',
        'options': '⚙',
    },
    'help': {
        'manual': '📖',
        'keybindings': '⌨',
        'about': 'ℹ',
    },
}

for lang in ['ko', 'en', 'fr', 'zh-CN', 'ar']:
    p = f'resources/i18n/{lang}/menu.json'
    d = json.load(open(p, encoding='utf-8'))
    cnt = 0
    for sec, kv in d.items():
        if not isinstance(kv, dict):
            continue
        section_icons = ICONS.get(sec, {})
        for k, icon in section_icons.items():
            if k in kv and isinstance(kv[k], str):
                v = kv[k].lstrip()
                # 이미 아이콘이 있으면 그대로 (중복 방지)
                if not v.startswith(icon):
                    kv[k] = f'{icon} {v}'
                    cnt += 1
    json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'== {lang} == {cnt} icons restored')
