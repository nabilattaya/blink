# Blink live widget refresh

Blink is a thin fork of [Glance](https://github.com/glanceapp/glance) that adds opt-in, per-widget live refreshing without requiring a full page reload.

The feature is intentionally additive. Widgets without `refresh:` retain normal Glance behavior and make no periodic fragment requests.

## Basic configuration

Add `refresh:` to a native leaf widget using the same duration syntax used elsewhere in Glance:

```yaml
- type: rss
  title: News
  cache: 15m
  refresh: 15m
  feeds:
    - url: https://example.com/feed.xml
```

`refresh:` and `cache:` serve different purposes:

- `refresh:` controls how often the browser asks Blink to re-render that widget.
- `cache:` controls when Glance considers the widget's upstream data stale and fetches it again.

Using the same value for both is a sensible default for many API-backed widgets. A shorter `refresh:` than `cache:` re-renders cached data more often without necessarily making another upstream request. A longer `refresh:` can leave already-refreshed server data undisplayed until the next browser refresh interval.

## Containers

Set `refresh:` on the actual child widgets that should update. Blink supports refreshable widgets nested inside `group` and `split-column`, but the container wrapper itself does not accept `refresh:`.

```yaml
- type: group
  widgets:
    - type: rss
      title: News
      cache: 15m
      refresh: 15m
      feeds:
        - url: https://example.com/feed.xml

    - type: markets
      cache: 5m
      refresh: 5m
      markets:
        - symbol: SPY
          name: S&P 500
```

This avoids overlapping parent/child replacement schedules.

## Browser behavior

When a refresh interval expires, Blink requests only that widget's rendered fragment. The server still uses Glance's normal `requiresUpdate` and cache behavior, so an upstream fetch happens only when the widget is actually due.

After a successful replacement, Blink runs the same content initialization lifecycle used on initial page load. Interactive native behavior such as clocks, calendars, to-do lists, search controls, popovers, carousels, lazy images, collapsible content, masonry layouts, and relative timestamps is therefore restored on the new subtree rather than maintained by a separate refresh-only initialization path.

Blink also:

- pauses periodic refresh while the document is hidden;
- aborts in-flight fragment work when the page becomes hidden;
- catches overdue widgets up when the page becomes visible again;
- limits simultaneous fragment refreshes so equal intervals do not create an unrestricted request burst;
- times out stalled fragment requests and retries transient failures;
- uses retry delays of 30 seconds, 1 minute, 2 minutes, and 5 minutes before returning to the configured interval.

## Configuration hot reload

Glance recreates its application when a valid watched configuration changes. Runtime widget IDs can therefore change while an older browser tab still contains the previous IDs.

If Blink receives a page-state response such as `404` for a widget that was already active, it reloads the page instead of retrying that stale widget ID forever. Authentication/session responses (`401`/`403`) are treated the same way so the browser can re-enter the normal page/authentication flow.

## Failure behavior

Transient network and server failures do not replace the currently displayed widget. Blink logs the failed refresh in the browser console and schedules a retry using the backoff sequence above.

A returned fragment is accepted only when it contains the expected widget ID. Invalid fragments are rejected and retried rather than replacing unrelated DOM.

## Fork architecture

Blink deliberately keeps the Go module path as:

```text
github.com/glanceapp/glance
```

This minimizes source-level divergence from upstream Glance. Blink-specific browser scheduling and replacement behavior lives in `internal/glance/static/js/native-refresh.js`, with only small integration/lifecycle changes in Glance's existing page code.

The intended fork workflow is to keep Blink's `main` aligned with upstream Glance and carry Blink behavior as a small patch stack above it.
