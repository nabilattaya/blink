package glance

import (
	"net/http"
	"strconv"
	"time"
)

func init() {
	// Avoid reusing stale browser widget IDs after a process restart.
	widgetIDCounter.Store(uint64(time.Now().UnixNano()))
}

func (a *application) registerWidget(page *page, widget widget) {
	a.widgetByID[widget.GetID()] = widget
	a.pageByWidgetID[widget.GetID()] = page

	switch container := widget.(type) {
	case *groupWidget:
		for i := range container.Widgets {
			a.registerWidget(page, container.Widgets[i])
		}
	case *splitColumnWidget:
		for i := range container.Widgets {
			a.registerWidget(page, container.Widgets[i])
		}
	}
}

func (a *application) handleNativeWidgetContentRequest(
	w http.ResponseWriter,
	r *http.Request,
) {
	if a.handleUnauthorizedResponse(w, r, showUnauthorizedJSON) {
		return
	}

	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(
			w,
			http.StatusText(http.StatusMethodNotAllowed),
			http.StatusMethodNotAllowed,
		)
		return
	}

	widgetID, err := strconv.ParseUint(
		r.PathValue("widget"),
		10,
		64,
	)
	if err != nil {
		a.handleNotFound(w, r)
		return
	}

	widget, exists := a.widgetByID[widgetID]
	if !exists {
		a.handleNotFound(w, r)
		return
	}

	page, exists := a.pageByWidgetID[widgetID]
	if !exists {
		a.handleNotFound(w, r)
		return
	}

	page.mu.Lock()
	defer page.mu.Unlock()

	now := time.Now()
	if widget.requiresUpdate(&now) {
		widget.update(r.Context())
	}

	w.Header().Set(
		"Content-Type",
		"text/html; charset=utf-8",
	)
	w.Header().Set("Cache-Control", "no-store")
	w.Write([]byte(widget.Render()))
}
