# de Rederij Mobile First

Nieuwe opzet voor de Rederij-site, met deze uitgangspunten:

- mobiel eerst
- snel en duidelijk invullen belangrijker dan veel informatie tegelijk tonen
- desktop volgt later als tweede laag
- pagina voor pagina bouwen en testen

Eerste fase:

- gedeelde stijl en navigatie opzetten
- startpagina vereenvoudigen
- losse placeholders maken voor planning, zeildagen, logboek, informatie en kasboek

Lokale start:

- dubbelklik op `start-website.bat`
- of gebruik `npm run dev`

Daarna openen in de browser:

- `http://127.0.0.1:3100`

Aanpak voor vervolg:

1. per pagina bepalen wat het hoofddoel op telefoon is
2. eerst de mobiele versie ontwerpen
3. daarna pas desktop uitbreiden
4. pas verder naar de volgende pagina als de vorige prettig werkt

Nieuwe technische basis:

- SQLite-database in `data/rederij.sqlite`
- eerste accountlaag voor leden, bestuur en beheerder
- sessies via cookie-login
- startpagina blijft straks openbaar, ledenpagina's volgen achter login

Eerste login-test:

- open `http://127.0.0.1:3100/login.html`
- maak daar een eerste beheerder aan
- daarna kunnen we uitnodigingen, rollen en beheer gaan uitbreiden
