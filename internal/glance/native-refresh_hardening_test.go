package glance

import (
	"context"
	"html/template"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestGroupWidgetRejectsRefresh(t *testing.T) {
	widget := &groupWidget{}
	widget.RefreshInterval = durationField(time.Minute)

	err := widget.initialize()
	if err == nil {
		t.Fatal("groupWidget.initialize() error = nil, want refresh validation error")
	}

	if !strings.Contains(err.Error(), "set refresh on child widgets instead") {
		t.Fatalf("groupWidget.initialize() error = %q, want child-widget guidance", err)
	}
}

func TestSplitColumnWidgetRejectsRefresh(t *testing.T) {
	widget := &splitColumnWidget{}
	widget.RefreshInterval = durationField(time.Minute)

	err := widget.initialize()
	if err == nil {
		t.Fatal("splitColumnWidget.initialize() error = nil, want refresh validation error")
	}

	if !strings.Contains(err.Error(), "set refresh on child widgets instead") {
		t.Fatalf("splitColumnWidget.initialize() error = %q, want child-widget guidance", err)
	}
}

type nativeRefreshContextWidget struct {
	widgetBase
	contextErr error
}

func (widget *nativeRefreshContextWidget) initialize() error {
	return nil
}

func (widget *nativeRefreshContextWidget) update(ctx context.Context) {
	widget.contextErr = ctx.Err()
	widget.scheduleNextUpdate()
}

func (widget *nativeRefreshContextWidget) Render() template.HTML {
	return template.HTML(`<div data-widget-id="42"></div>`)
}

func TestWidgetContentEndpointUsesRequestContext(t *testing.T) {
	widget := &nativeRefreshContextWidget{}
	widget.Type = "test"
	widget.ID = 42
	widget.cacheType = cacheTypeDuration
	widget.cacheDuration = time.Hour

	page := &page{}
	app := &application{
		widgetByID: map[uint64]widget{42: widget},
		pageByWidgetID: map[uint64]*page{42: page},
	}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/widgets/42/content/",
		nil,
	).WithContext(ctx)
	request.SetPathValue("widget", "42")

	response := httptest.NewRecorder()
	app.handleNativeWidgetContentRequest(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
	}

	if widget.contextErr != context.Canceled {
		t.Fatalf("widget update context error = %v, want context.Canceled", widget.contextErr)
	}
}
