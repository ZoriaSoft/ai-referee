# ai-referee

Yapay zekâ ajanları artık el yazısıyla incelenemeyecek kadar çok PR açıyor.
ai-referee, **yerel ve kendi kendine barındırılan bir merge kapısıdır**: testlerini
çalıştırır, diff'i herhangi bir ajan CLI'sine (`claude`, `codex`, `gemini`…) veya
OpenAI uyumlu bir API'ye gönderir ve bir karar döner:

```
APPROVE → çıkış 0      REJECT → çıkış 1      çalışamadı → çıkış 2
```

Hiçbir reviewer cevap veremezse onay vermeyi reddeder. **Hakem yoksa merge de yok.**

## 30 saniyede başlangıç

```bash
cd projen
npx ai-referee@latest init        # .ai-referee.json oluşturur
# testCommand ve en az bir reviewer ayarla
npx ai-referee@latest review      # mevcut dalı base'e karşı inceler
```

Örnek `.ai-referee.json` (yorum serbest):

```jsonc
{
  "testCommand": "npm test",
  "reviewers": [
    { "name": "claude", "type": "cli", "command": "claude -p" },
    { "name": "codex",  "type": "cli", "command": "codex exec -" }
  ]
}
```

## Ne yapar

- Yerel dal diff'ini (`--base`, `--uncommitted`) veya GitHub PR'ını (`--pr N`)
  tek kullanımlık bir `git worktree` içinde inceler — checkout'una dokunmaz.
- `testCommand` geçmezse REJECT — LLM devreye girmeden bile.
- Büyük diff'leri `chunkBudget` altında parçalar; `exclude` glob'ları kilit
  dosyalarını atlar.
- Reviewer'ları sırayla dener (fallback chain); çıktısı bozuksa bir kez uyarır,
  yine olmazsa o parça başarısız sayılır → REJECT.
- Markdown (TTY) ve JSON (pipe) rapor; `--format`, `--out`.
- `--fix`: REJECT'te `fixerCommand`'ı bir kez çalıştırıp yeniden inceler.
- `daemon`: `gh pr list`'i yoklar, her yeni PR head'ini bir kez inceler,
  raporları `.ai-referee/reports/` altına yazar.
- `hook install`: REJECT'te push'u durduran pre-push kancası kurar.

## Mevcut araçlardan farkı

pr-agent gibi araçlar CI/SaaS üzerinde tavsiye yorumu bırakır; git-ai-review ve
benzerleri yerel inceler ama kapı koymaz. ai-referee **fail-closed** çalışır:
ayrıştırılamayan çıktı, ulaşılamayan reviewer ve kırık testlerin hepsi REJECT'tir.
GitHub Actions gerekmez.

## Sınırlar

- Reviewer sadece diff + README özeti görür (derin sembol bağlamı yok).
- Reviewer/test komutları `bash` ister; Windows desteklenmez.
- PR/daemon modları `gh` CLI ve GitHub `origin` ister.
- `--fix` tek tur ve yalnız yerel hedeflerde.

## Gereksinimler

Node ≥ 20, `git` ≥ 2.38, PR/daemon için `gh`. Lisans: MIT.
