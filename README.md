# Bot komentarzy na Instagramie

Pod wskazanym postem/reelsem dla każdego nowego komentarza:

1. wysyła **prywatną wiadomość (DM) z przepisem** (Private Replies),
2. odpisuje **publicznie** („@nick wysłane, sprawdź DM 💌" – losowy wariant z `config.json`).

Działa lokalnie, na oficjalnym API Meta (tym samym, z którego korzysta ManyChat). Co minutę sam pyta
Instagram o nowe komentarze, więc **nie potrzebujesz ngroka, publicznego adresu ani webhooków**. Nie wymaga
żadnych zależności – Node 20.12+ (albo 10.17+, patrz niżej). Bez strony na Facebooku (lajkowanie komentarzy: dodatek B).

## Dwie wersje: Node 20.12+ i Node 10.17+

Logika bota jest jedna (`lib/bot-core.js`, napisana tak, żeby działała na obu wersjach Node). Pliki wejściowe różnią
się tylko tym, czego brakuje starym wersjom Node (`fetch` i `process.loadEnvFile`):

| | Node 20.12+ (komputer) | Node 10.17+ (np. stary telefon z Kali) |
|---|---|---|
| bot | `npm start` (= `node bot.mjs`) | `npm run start:node10` (= `node node10/bot.js`) |
| lista postów, próba | `npm run media`, `npm run dry` | `npm run media:node10`, `npm run dry:node10` |
| jednorazowe ustawienie tokenu | `npm run setup` | `npm run setup:node10` |

**Obie wersje używają tych samych plików z głównego katalogu**: `.env`, `config*.json`, `recipe*.txt`, `state*.json`
i `logs/`. Możesz więc bez zmian przełączać się między nimi albo skopiować katalog na telefon. Argumenty są te same
(`--dry-run`, `--once`, `--debug`, `--account=...`); przy `npm run ...:node10` dodaj `--` przed argumentami.

**Na telefonie (Node 10):**
- Skopiuj cały katalog (z `lib/` i `node10/`) i sprawdź `node -v` (≥ 10.17). `npm` nie jest potrzebny:
  `node node10/bot.js --dry-run`.
- Jeśli kampania już trwa, skopiuj też `state.<konto>.json`. Bez niego bot uzna wszystkie komentarze za nowe i wyśle
  DM-y ponownie. **Nie uruchamiaj dwóch kopii** (komputer i telefon) na tym samym koncie i poście.
- Node 10 ufa tylko własnej, starej liście certyfikatów (2019). Przy błędzie certyfikatu
  (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `CERT_...`) uruchom:
  `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt node node10/bot.js`
- Token bez `.env` na dysku: zaszyfruj go (`gpg --symmetric --cipher-algo AES256 --output .env.gpg .env`), trzymaj
  `.env.gpg` w `../allchat-token/` (albo wskaż plik przez `ALLCHAT_TOKEN_FILE=`) i uruchamiaj
  `node run_allchat --dry-run --account=...`. gpg pyta o hasło, a odszyfrowany token trafia tylko do pamięci bota.
  Jeśli gpg nie pokaże pytania o hasło, uruchom wcześniej `export GPG_TTY=$(tty)`. Usuń wtedy zwykły `.env` z telefonu.
- Node 10 jest bez wsparcia od 2021 r. Bot tylko odpytuje API Meta i nie przyjmuje żadnych połączeń z zewnątrz.

**Dla piszących kod:** wszystko w `lib/*.js` i `node10/*.js` musi mieścić się w ES2018 (bez `?.`, `??`, `replaceAll`,
`.at()`, `flatMap`, `fetch`, importów `node:...`). Nowoczesne API wolno tylko w plikach `.mjs`. Wspólny kod nie jest
też ES modułem, dlatego w `package.json` nie ma `"type": "module"`. Podział: `lib/util.js` (drobne funkcje),
`lib/errors.js` (`GraphError`, `NetworkError`), `lib/bot-core.js` i `lib/setup-core.js` (logika),
`lib/transport.js` i `lib/env.js` (zamienniki `fetch` i `process.loadEnvFile` dla Node 10),
`lib/fetch-transport.mjs` (`fetch` dla nowego Node).

## Konfiguracja (jednorazowo)

### 1. Konto Instagram
Musi być **zawodowe** (Creator lub Business – darmowa zmiana w Ustawieniach → Typ konta i narzędzia)
i **publiczne** (nie prywatne).

### 2. Aplikacja Meta
Na <https://developers.facebook.com> aplikacja typu **Business** z przypadkiem użycia
**Manage messaging & content on Instagram**, w trybie **Development** (to Twoje własne konto, więc przegląd
aplikacji i weryfikacja firmy nie są potrzebne). Zakładka „API setup with Unified login" pojawia się tylko
dla aplikacji powiązanych z business portfolio.

### 3. Konfiguracja uprawnień
*Przykłady użycia* → **Customize** → **API setup with Unified login** → *Configure your app* →
**Create new configuration**. Potrzebujesz uprawnień `instagram_basic`, `instagram_manage_messages`
i `instagram_manage_comments` (uprawnienia reklamowe `ads_*` możesz usunąć w *Edit permissions*).
Kliknij **Use this configuration**. Meta poprosi o *Redirect URL*: bot go nie używa, wpisz
`https://example.com/callback` (formularz odrzuca `localhost`, wymaga poprawnego adresu HTTPS; nic na nim nie działa).

### 4. Token
W sekcji *Generate access tokens*:
1. najpierw w *App roles* → *Role* dodaj swoje konto Instagram jako **Instagram Tester** (panel przypomina
   o tym w opisie tego kroku), potem kliknij **Add account**,
2. przyjmij zaproszenie w Instagramie **w przeglądarce**: Ustawienia → Uprawnienia witryn (Website
   permissions) → Aplikacje i witryny → Tester Invites,
3. kliknij **Generate token**, dokończ logowanie i **od razu skopiuj token** (pokazuje się tylko raz).

```bash
cp .env.example .env     # i wklej token w linii META_TOKEN=
```
Bot sam znajdzie Twoje konto Instagram. Jeśli token obejmuje kilka kont, poprosi o `IG_USER_ID`.
Jeśli token wygaśnie lub przestanie działać, bot to zgłosi – wygeneruj nowy tym samym przyciskiem.

### 5. Post i przepis
Własne ustawienia i przepis trzymasz w plikach, których **nie ma w repozytorium** (są w `.gitignore`), a w repo leżą
tylko wzory:
```bash
cp config.example.json config.json   # Twoje ustawienia (id posta, odpowiedzi, przerwy, punkt startu)
cp recipe.example.txt recipe.txt     # treść DM-a
npm run media     # lista ostatnich postów z ich id -> wpisz id do config.json ("mediaId")
```
Treść DM wpisz w `recipe.txt` (patrz limity niżej).

> **Nic z tego nie commituj:** `.env` (token), `config*.json` (id posta, nazwa użytkownika w `startFromUsername`),
> `recipe*.txt`, `state*.json` (lista osób, które dostały wiadomość) i `logs/` (nazwy użytkowników, którzy komentowali).
> Wszystko to jest w `.gitignore`; w repo są tylko `.env.example`, `config.example.json` i `recipe.example.txt`.

### 6. Uruchomienie
```bash
npm run dry       # tryb próbny: czyta komentarze i pokazuje, co by zrobił; nic nie wysyła
npm start         # na serio. Ctrl+C zatrzymuje, po ponownym starcie nic się nie dubluje (state.json)
```
Komputer musi być włączony i nie może zasypiać: `caffeinate -i npm start`.

## Limity, o których warto wiedzieć

- **Przepis ma max 1000 bajtów** (ok. 800–900 znaków z polskimi literami i emoji). Prywatna odpowiedź na
  komentarz może być tylko **jedna**, więc przy dłuższym przepisie wstaw link (blog, Notion, Google Doc).
  Bot odmówi startu, jeśli tekst jest za długi.
- DM można wysłać do **7 dni** od komentarza. Starsze komentarze zostaną pominięte.
- Jeśli ktoś Cię nie obserwuje, wiadomość ląduje w jego **„Prośbach o wiadomości"**, nie w skrzynce.
- W Instagramie musi być włączone **„Zezwalaj na dostęp do wiadomości"**: Ustawienia → Wiadomości i
  odpowiedzi na relacje → Kontrola wiadomości → Połączone narzędzia. Inaczej API zwróci błąd `(#200)`.
- Bot nie odpowiada na własne komentarze, a druga osoba komentująca ponownie nie dostaje drugiego DM
  (`oneDmPerUser`).
- **Limity Meta.** Są dwa różne: prywatnych odpowiedzi wolno wysłać 750 na godzinę na konto, a **cała aplikacja**
  ma osobny limit zapytań do API (`(#4) Application request limit reached`): według dokumentacji 200 zapytań na
  godzinę razy liczba aktywnych użytkowników aplikacji, czyli dla małej aplikacji testowej rząd kilkuset. Ten drugi
  jest ważniejszy: zużywa go każde zapytanie, także samo sprawdzanie komentarzy. Dlatego bot:
  - co minutę zadaje jedno tanie pytanie o liczbę komentarzy i czyta listę dopiero, gdy ktoś **inny** napisał
    komentarz (własne odpowiedzi bota też zwiększają licznik, ale bot to uwzględnia);
  - czyta listę od najnowszych i przestaje po pierwszej stronie, na której nie ma już nic do zrobienia (1–2
    zapytania zamiast jednego na każde 50 komentarzy); pełny odczyt robi tylko na starcie i co 10 minut
    (`fullRefreshSeconds`) dla pewności;
  - sam liczy własne zapytania z ostatniej godziny (widać to w logu: „zapytań API w ostatniej godzinie") i nie
    przekracza `maxCallsPerHour` (domyślnie 400), tylko czeka. Licznik jest zapisany w `state.json`, więc restart
    go nie zeruje. Gdy mimo to Meta zgłosi prawdziwy błąd `#4`, bot **zapamiętuje**, ile zapytań wykonał, i trzyma
    się 85% tej liczby (`learnedCap` w `state.json`; usuń to pole, jeśli chcesz zacząć od nowa);
  - odczytuje z odpowiedzi Meta zużycie limitu („limit Meta"): od 60% odpytuje 3 razy rzadziej, od 85% czeka
    5 minut (`pauseAtUsagePercent`, `usagePauseSeconds`).

  Przerwy między komentarzami (`delaySeconds`) rozkładają wysyłkę w czasie. Gdy mimo to Instagram zgłosi limit,
  bot robi 30 min przerwy. Prawdziwe zużycie aplikacji widać w panelu Meta: karta **Application Rate Limit** →
  *View Details*. **Nie uruchamiaj kilku kopii bota naraz** (np. `npm run dry` w osobnym oknie): wszystkie
  zużywają ten sam limit.
- **Brak internetu** (zerwane Wi-Fi, uśpiony komputer, VPN) nie zatrzymuje bota: czeka 15 s, potem 30 s, 1, 2,
  4 i co 5 minut (`networkRetrySeconds` w `config.json`), aż połączenie wróci, i wtedy sam kontynuuje. To, co
  już zostało wysłane, jest zapisane w `state.json`. Mimo to lepiej nie usypiać komputera: `caffeinate -i npm start`.
- `triggerRegex` w `config.json` pozwala reagować tylko na wybrane komentarze, np. `"❤|przepis"`.
  Puste = każdy komentarz dostaje przepis.
- **Od kogo zacząć:** jeśli komentarze były wcześniej obsługiwane ręcznie, wpisz w `config.json`
  `"startFromUsername": "nazwa_uzytkownika"` (pierwsza osoba, która **jeszcze nie dostała** przepisu). Bot
  znajdzie jej najstarszy komentarz pod postem i obsłuży tylko komentarze od niego włącznie (kolejność:
  od najstarszego), wcześniejsze zostawi w spokoju. Punkt startu zapamiętuje w `state.json`. Wybierz osobę
  ostrożnie: komentarze po niej, na które ktoś zdążył już odpisać ręcznie, dostałyby przepis drugi raz.
  Bot zatrzymuje się z komunikatem, jeśli takiej nazwy nie ma pod postem. Gdy bot działa, nie odpowiadaj już
  ręcznie na nowe komentarze.
- **Komentarze obsłużone ręcznie (inna metoda):** jeśli właściciel konta lajkuje komentarze, na które już odpisał, ustaw
  `"skipIfLikedAtLeast": 1` w `config.json`. Bot pominie wtedy komentarze mające choć jedno polubienie. API
  Meta nie mówi, *kto* polubił, tylko ile jest polubień, więc to przybliżenie: komentarz z 0 polubień na pewno
  nie był obsłużony, a polubiony przez kogoś innego (bez odpowiedzi) zostałby pominięty. Filtr dotyczy tylko
  komentarzy napisanych **przed pierwszym prawdziwym uruchomieniem bota** (moment zapisuje w `state.json` jako
  `baseline`); nowsze komentarze są obsługiwane zawsze, nawet jeśli ktoś je polubił. Jeśli Instagram przestanie
  zwracać `like_count`, bot się zatrzyma, zamiast wysyłać przepis drugi raz. Gdy bot działa, nie odpowiadaj
  już ręcznie na nowe komentarze, bo mogą dostać przepis dwa razy.
- Nie używaj nieoficjalnych bibliotek logujących się hasłem – to prosta droga do blokady konta.

## Diagnostyka (gdy coś nie działa albo limit znika za szybko)

- **Zwykły log** pokazuje przy każdej wysyłce zużycie: `✓ dm -> @nick  [API: 71/h · Meta: app 34%, odczyty 1%]`
  (własny licznik zapytań z ostatniej godziny i procenty z nagłówków Meta: „app" widać na wysyłkach, „odczyty" na
  odczytach). Przy zwolnieniu z powodu limitu bot dopisuje surowe nagłówki i to, które zapytanie je przyniosło.
  Pokazuje też, dlaczego pominął komentarz (np. „ta osoba już dostała przepis") i co ok. 5 minut „czuwam: …",
  gdy nic się nie dzieje. Każda osoba ma swój blok: ciężki nagłówek
  `══════ [3/97] @nick · komentarz sprzed 147 min ═══`, cienką kreskę `┈┈┈` między DM a odpowiedzią i stopkę
  `└─ @nick: dm ok · reply ok · 7 s`, a między osobami widać przerwę `⏳ przerwa 47 s przed następną osobą`.
  Odczyt „app" (miernik aplikacji) odświeża się **tylko przy DM-ach**, bo odpowiedzi publiczne i odczyty go nie niosą.
  Dlatego `app ?` znaczy „jeszcze nie znam", a `app 87% (sprzed 5 min)` pokazuje wiek odczytu. Hamulec (pauza) działa
  wyłącznie przed kolejnym DM, nie przed odpowiedzią publiczną.
- **`--debug`** (albo `DEBUG=1`, albo `"debug": true` w `config.json`) wypisuje dodatkowo każde zapytanie (`→`) i
  odpowiedź (`←` z czasem i nagłówkami zużycia), każdą stronę listy komentarzy (ile komentarzy, czy Meta zwróciła
  `paging.next`), powody odfiltrowania komentarzy, kolejkę do obsłużenia i długość przerw:
  ```bash
  npm start -- --account=second --debug 2>&1 | tee -a logs/second-debug.log
  ```
- **`logs/api.<konto>.jsonl`** (zawsze włączony): jedna linia JSON na każde zapytanie do API: czas, metoda, ścieżka,
  status, czas trwania, kod błędu i surowe nagłówki zużycia. **Bez tokenów, treści wiadomości i nazw użytkowników.**
  Po takim pliku da się policzyć, ile procent limitu kosztuje każdy rodzaj zapytania.
  Plik rotuje się po 5 MB. Folder `logs/` jest w `.gitignore`.
- Tokeny nigdy nie trafiają do logów: idą w nagłówku `Authorization`, a ewentualny `access_token` w adresie
  następnej strony jest wycinany.

## Dodatki

**A. Gdy w panelu jest „API setup with Instagram Login"** (Meta pokazuje różne opcje różnym aplikacjom):
w *Generate access tokens* kliknij **Add account**, zaloguj się na Instagram i **Generate token**, a token
wpisz do `.env` jako `IG_TOKEN=` (zamiast `META_TOKEN`). Uprawnienia: `instagram_business_basic`,
`instagram_business_manage_messages`, `instagram_business_manage_comments`. Token ważny 60 dni.

**B. Lajkowanie komentarzy** Meta dokumentuje tylko przy logowaniu przez Facebooka (**API setup with
Facebook Login**), co wymaga **strony na Facebooku** (Facebook Page, nie profil osobisty) podpiętej do
Instagrama. Uprawnienia: `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages`,
`instagram_manage_engagement`, `pages_show_list`, `pages_read_engagement`. Token wygenerujesz w Graph API
Explorer, `npm run setup` zamieni go na token bez daty ważności (zapisze `PAGE_TOKEN` i `IG_USER_ID`),
a w `config.json` ustaw `"likeComments": true`.

## Dodatek C: drugie konto Instagram (np. dla innej osoby)

Dodaj je tak samo jak pierwsze (rola Instagram Tester, przyjęcie zaproszenia, „Zezwalaj na dostęp do
wiadomości", *Generate token*; logować się musi właściciel tego konta). Bot obsługuje jedno konto na proces,
ale w jednym `.env` może leżeć kilka kont. Nazwij zmienne z przyrostkiem (np. dla konta „second"):

```bash
# w .env
META_TOKEN_SECOND=...
IG_USER_ID_SECOND=...

# osobne pliki: config.second.json (jej "mediaId", "recipeFile") i recipe.second.txt (jej przepis)
npm run media -- --account=second      # ostatnie posty tego konta
npm run dry   -- --account=second      # próba
npm start     -- --account=second      # na serio (stan zapisuje w state.second.json)
```
(`ACCOUNT=second npm start` robi to samo.) Bez `--account` bot używa zwykłych `META_TOKEN` i `IG_USER_ID`.
Token daje dostęp do wiadomości prywatnych tego konta, więc `.env` trzymaj tylko u siebie. Tryb Development
(Standard Access) jest przeznaczony dla kont własnych lub takich, którymi zarządzasz; obsługa wielu obcych kont
wymaga App Review w Meta.

## Testy
Jeden zestaw testów uruchamia bota na atrapie API Meta (bez konta i internetu), na wybranym pliku wejściowym.
Sam uruchamiacz (`node --test`) wymaga Node 18+, więc testy odpalasz na komputerze, nie na telefonie:

```bash
npm test                 # bot.mjs (Node 20.12+, fetch)
npm run test:node10      # node10/bot.js (https zamiast fetch)
npm run test:oldapi      # j.w., ale bot dostaje "shim" odbierający API, których nie ma w Node 10 (fetch, flat, at, node:...)
npm run test:all         # wszystkie trzy po kolei
# bot na PRAWDZIWYM Node 10 (uruchamiacz testów zostaje na nowym Node):
BOT_NODE=/ścieżka/do/node10/bin/node npm run test:node10
# czy kod dla Node 10 nie wychodzi poza ES2018 (wymaga parsera acorn, który nie jest zależnością bota):
ACORN=/ścieżka/do/node_modules/acorn npm run lint:node10
```
