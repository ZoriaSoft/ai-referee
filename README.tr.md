# ai-referee

<p align="center"><img src="docs/flow.svg" alt="ai-referee flow: tests, AI review, merge only at the reviewed commit" width="100%"></p>

**Yerel, modelden bağımsız bir merge kapısı: hakem yoksa merge de yok.**

ai-referee testlerini çalıştırır, diff'i herhangi bir ajan CLI'sine (`claude`,
`codex`, `gemini`…) veya OpenAI uyumlu bir API'ye gönderir ve cevabı çıkış
koduna çevirir:

```
APPROVE → çıkış 0      REJECT → çıkış 1      çalışamadı → çıkış 2
```

Yorum bırakan bir bot değil, **kapıdır**. Kırık test, okunamayan cevap, zaman
aşımı ya da kotası biten reviewer zinciri — hepsi REJECT. Senin makinende veya
sunucunda, zaten giriş yaptığın CLI'larla çalışır; SaaS ya da GitHub Actions
gerekmez.

## Hızlı başlangıç (temiz kurulum)

Node.js ≥ 22, git ≥ 2.38 ve en az bir reviewer gerekir. Henüz npm'de yok;
kaynaktan kur:

```bash
git clone https://github.com/ZoriaSoft/ai-referee.git
cd ai-referee && npm ci && npm run build && npm link   # `ai-referee` PATH'e girer

cd /projenin/yolu
ai-referee init          # başlangıç .ai-referee.json yazar
# testCommand'ı ayarla, elinde olan en az bir reviewer'ı bırak
ai-referee doctor        # config, reviewer, gh kontrolü
ai-referee review        # mevcut dalı base'e karşı incele
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
  dosyalarını atlar; `contextBudget` kadar tam dosya içeriğini prompt'a ekler.
- Parçaları `reviewConcurrency` (varsayılan 2) ile paralel inceler;
  reviewer'ları sırayla dener (fallback chain); çıktısı bozuksa bir kez uyarır,
  yine olmazsa o parça başarısız sayılır → REJECT.
- Markdown (TTY) ve JSON (pipe) rapor; `--format`, `--out`.
- `--fix`: REJECT'te `fixerCommand`'ı bir kez çalıştırıp yeniden inceler.
- `--comment`: PR'a GitHub review'ı olarak yazar — diff satırlarına denk gelen
  bulgular satır içi yorum olur (`start_line` aralığı verilmişse ve iki uç da
  diff'teyse çok satırlı yorum); satıra denk gelmeyip dosyası diff'te olanlar
  dosya seviyesi yoruma düşer, kalanlar review gövdesine girer. Yeni bir head
  incelendiğinde, eski commit'e ait ai-referee `CHANGES_REQUESTED` review'ları
  otomatik dismiss edilir; insan review'larına dokunulmaz.
- `--status` (veya `"commitStatus": true`): PR head SHA'sına GitHub commit
  status'u yazar — inceleme başlarken `pending`, sonunda `success`/`failure`
  (context `ai-referee`). Branch protection'da bu context'i zorunlu kılarsan
  kapı gerçekten uygulanır: ai-referee onaylamadan merge kapanmaz. Yazma
  hataları verdict'i değiştirmez (best-effort).
- `--confirm` (veya `"confirmRejections": true`): her REJECT, zincirdeki
  **ikinci hakeme** doğrulatılır — yargılayan hakem kendini onaylayamaz.
  İkinci hakem APPROVE derse ret kararı engellemek yerine uyarıya dönüşür;
  doğrulama yapılamazsa REJECT olduğu gibi kalır (kapı kendini asla açmaz).
- `doctor`: config, reviewer binary'leri, API anahtarları ve `gh` kimliğini
  tek komutta doğrular.
- `daemon`: `gh pr list`'i yoklar, her yeni PR head'ini bir kez inceler,
  raporları `.ai-referee/reports/` altına yazar; `--comment` ile PR'a yazar.
  `gh` hatalarında yoklama aralığı üssel olarak geriler (en fazla 8×) ve
  yoklamalar asla çakışmaz; `--concurrency` / `"daemonConcurrency"` (1–8)
  ile bir geçişte birden çok PR paralel incelenir — her head kendi
  `refs/ai-referee/pr-<n>` ref'ine çekilir (FETCH_HEAD paylaşılmaz) ve kendi
  worktree'sinde değerlendirilir. systemd unit örneği README.md'de.
- `hook install`: REJECT'te push'u durduran pre-push kancası kurar.
- `--strict`/`--light`: inceleme profili — `strict` tam denetim yapar,
  `light` yalnız merge'i bozan hatalara takılır (çökme, veri kaybı, güvenlik
  açığı); config'te `"profile"` ile de ayarlanır. Kapı da aynı sözleşmeyi
  uygular: `light` profilde blocker bulgusu göstermeyen bir REJECT engellemek
  yerine raporda uyarıya dönüşür.
- `routes`: glob eşleşen dosyaları belirli reviewer'lara yollar — örn.
  `src/auth/**` güçlü bir güvenlik modeline, geri kalanı ucuz varsayılana.
  Yönlendirilen dosyalar ayrı parçalarda incelenir; kendi hakemleri cevap
  vermezse varsayılan zincire sessizce düşmezler → REJECT (fail-closed).
  Route'a `"fixer"` ile kendi düzeltici komutunu verebilirsin: o route'a
  düşen bulgular yalnız ona gider; `"fixer": null` dosyaları düzeltmeden
  muaf tutar. Route'suz dosyalar genel `fixerCommand`'ı kullanır.

## Güvenlik modeli

Ayrıntılar README.md'deki "Security model" bölümünde; özet:

- **Merge, incelenen commit'e bağlıdır.** `--pr` modunda PR head'i tam SHA
  olarak sabitlenir; diff, prompt bağlamı ve testler o commit üzerinde koşar.
  `--merge` öncesi head yeniden okunur, değiştiyse merge reddedilir; ayrıca
  `gh pr merge --match-head-commit <sha>` kullanılır. Testler koşmadıysa
  otomatik merge yapılmaz. Testler HEAD'i oynatır ya da izlenen dosyaları
  değiştirirse REJECT.
- **Testler PR'ın kodunu çalıştırır.** Daemon'ı container/VM/ayrı kullanıcı
  içinde çalıştır. PR modunda token/anahtar görünümlü ortam değişkenleri test
  sürecinden silinir (`"passSecretsToTests": true` ile geri açılır).
- **Config güvenilir taraftan gelir:** `.ai-referee.json` senin checkout'undan
  okunur, PR'dan değil; PR bu dosyayı değiştirirse raporda uyarı çıkar.
- **Diff veri, talimat değil:** diff rastgele bir nonce ile işaretlenmiş blok
  içinde gider; verdict JSON'u bu nonce'u taşımak zorunda
  (`"requireNonce": true`); aynı cevapta hem APPROVE hem REJECT varsa REJECT.
  PR modunda CLI reviewer'lar boş bir geçici dizinde çalışır
  (`"reviewerWorkdir": "isolated"`), PR'ın AGENTS.md/CLAUDE.md dosyalarını
  okumaz. Bu önlemler riski azaltır, sıfırlamaz.
- **Veri için shell yok:** git/gh çağrıları argv dizisiyle yapılır; PR
  numarası, SHA ve ref'ler doğrulanır.

## Mevcut araçlardan farkı

PR-Agent ve Copilot code review tavsiye niteliğinde yorum bırakır (Copilot
varsayılan olarak merge'i engellemez); CodeRabbit CLI bir hesap ve servis
ister. OpticDiff code-reviewer ruhen en yakın araç ve analiz tarafında daha
zengin; ai-referee'nin farkı testleri kapının içinde koşması, zaten giriş
yaptığın ajan CLI'larını fallback zinciriyle kullanması ve hiçbir hakem cevap
vermezse kapıyı kapalı tutması.

## Sınırlar

- LLM incelemesi sezgisel bir kapıdır, doğruluk ispatı değildir.
- Prompt injection önlemleri riski azaltır; modeli bağışık yapmaz.
- Reviewer diff + değişen dosyaların tam içeriğini görür (`contextBudget`);
  dosyalar arası sembol çözümlemesi yok.
- PR/daemon modları yalnız GitHub (`gh` CLI, `origin`).
- `--fix` tek tur ve yalnız yerel hedeflerde.
- Windows desteği best-effort; orada satır içi `{prompt}` kapalı.

## Gereksinimler

Node ≥ 22, `git` ≥ 2.38, PR/daemon için `gh`. Lisans: MIT.
