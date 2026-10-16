# hoondy.com

Hoondy Sq, a small personal station for side projects, games and odd ideas: the LQ
leadership test, Rush Hour and Scorched Borough, a few earlier projects, and a blog going
back to 2010.

The whole site is themed as a New York City subway station, "Hoondy Sq". It is built with
Jekyll on GitHub Pages, with plain CSS and vanilla JavaScript modules, so there is nothing to
compile beyond the Jekyll build that Pages already runs.

## Local development

```sh
bundle install
bundle exec jekyll serve
```

Then open http://127.0.0.1:4000. Local builds run in development mode, so Google Analytics and
AdSense are not loaded and the billboards show the house promos instead.

## Layout

- `_layouts/`, `_includes/`, `assets/css/main.css`, `assets/js/site.js`: the station theme
- `_pages/`: About, Projects, the blog archive, Tags, Categories, Privacy and the 404 page
- `_data/apps.yml`, `_data/lines.yml`: the apps and route bullets used across the site
- `_data/projects.yml`: earlier projects and the station's history (home, Projects, About)
- `_data/i18n.yml`: menu and footer wording for pages in other languages (the LQ test translations)
- `apps/<name>/` and `assets/apps/<name>/`: one folder per app
- `assets/js/lib/`: shared helpers for leaderboards and sharing
- `_posts/`: blog posts
- `server/leaderboard/`: the leaderboard worker (not part of the Jekyll build)

## Leaderboards and LQ statistics

Monthly game boards and the anonymous LQ score distribution run on a small Cloudflare Worker.
See `server/leaderboard/README.md`. Without it (`leaderboard_api` left empty in `_config.yml`),
each visitor gets a board on their own device and the LQ Test shows its expected distribution.

## Ads

Google ads appear only inside the billboard panels (`_includes/billboard.html`), one display
unit per format (`adsense.slots` in `_config.yml`). Auto ads should stay off in AdSense so
nothing else gets placed on the page.
