package glance

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

func TestWidgetRefreshIntervalParsing(t *testing.T) {
	var widgets widgets

	err := yaml.Unmarshal([]byte(`
- type: rss
  refresh: 15m
  feeds:
    - url: https://example.com/feed.xml
`), &widgets)
	if err != nil {
		t.Fatalf("unmarshal widgets: %v", err)
	}

	if len(widgets) != 1 {
		t.Fatalf(
			"len(widgets) = %d, want 1",
			len(widgets),
		)
	}

	widget, ok := widgets[0].(*rssWidget)
	if !ok {
		t.Fatalf(
			"widget type = %T, want *rssWidget",
			widgets[0],
		)
	}

	got := time.Duration(widget.RefreshInterval)
	want := 15 * time.Minute

	if got != want {
		t.Fatalf(
			"RefreshInterval = %v, want %v",
			got,
			want,
		)
	}

	if got := widget.GetRefreshIntervalMilliseconds(); got != 900000 {
		t.Fatalf(
			"GetRefreshIntervalMilliseconds() = %d, want 900000",
			got,
		)
	}
}

func TestWidgetBaseTemplateRendersRefreshInterval(t *testing.T) {
	widget := &rssWidget{}
	widget.Type = "rss"
	widget.ID = 42
	widget.Title = "Refresh Test"
	widget.RefreshInterval =
		durationField(15 * time.Minute)

	rendered := string(
		widget.renderTemplate(
			widget,
			rssWidgetTemplate,
		),
	)

	if !strings.Contains(
		rendered,
		`data-widget-id="42"`,
	) {
		t.Errorf(
			"rendered widget missing widget ID: %s",
			rendered,
		)
	}

	if !strings.Contains(
		rendered,
		`data-widget-refresh="900000"`,
	) {
		t.Errorf(
			"rendered widget missing refresh interval: %s",
			rendered,
		)
	}
}

func TestWidgetBaseTemplateOmitsRefreshWhenUnset(t *testing.T) {
	widget := &rssWidget{}
	widget.Type = "rss"
	widget.ID = 43
	widget.Title = "No Refresh"

	rendered := string(
		widget.renderTemplate(
			widget,
			rssWidgetTemplate,
		),
	)

	if strings.Contains(
		rendered,
		"data-widget-refresh=",
	) {
		t.Errorf(
			"rendered widget unexpectedly has refresh interval: %s",
			rendered,
		)
	}
}

func newNativeRefreshTestApplication() (*application, uint64) {
	testWidget := &rssWidget{}
	testWidget.Type = "rss"
	testWidget.ID = 42
	testWidget.Title = "Refresh Test"
	testWidget.RefreshInterval =
		durationField(15 * time.Minute)

	testPage := &page{}

	app := &application{
		widgetByID: map[uint64]widget{
			testWidget.ID: testWidget,
		},
		pageByWidgetID: map[uint64]*page{
			testWidget.ID: testPage,
		},
	}

	return app, testWidget.ID
}

func TestWidgetContentEndpoint(t *testing.T) {
	app, widgetID := newNativeRefreshTestApplication()

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/widgets/42/content/",
		nil,
	)
	request.SetPathValue(
		"widget",
		strconv.FormatUint(widgetID, 10),
	)
	request.SetPathValue("path", "content/")

	response := httptest.NewRecorder()

	app.handleWidgetRequest(response, request)

	result := response.Result()
	defer result.Body.Close()

	if result.StatusCode != http.StatusOK {
		t.Fatalf(
			"status = %d, want %d",
			result.StatusCode,
			http.StatusOK,
		)
	}

	if got := result.Header.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Errorf(
			"Content-Type = %q, want %q",
			got,
			"text/html; charset=utf-8",
		)
	}

	body := response.Body.String()

	if !strings.Contains(
		body,
		`data-widget-id="42"`,
	) {
		t.Errorf(
			"response missing widget ID: %s",
			body,
		)
	}

	if !strings.Contains(
		body,
		`data-widget-refresh="900000"`,
	) {
		t.Errorf(
			"response missing refresh interval: %s",
			body,
		)
	}
}

func TestWidgetContentEndpointRejectsNonGET(t *testing.T) {
	app, widgetID := newNativeRefreshTestApplication()

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/widgets/42/content/",
		nil,
	)
	request.SetPathValue(
		"widget",
		strconv.FormatUint(widgetID, 10),
	)
	request.SetPathValue("path", "content/")

	response := httptest.NewRecorder()

	app.handleWidgetRequest(response, request)

	result := response.Result()
	defer result.Body.Close()

	if result.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf(
			"status = %d, want %d",
			result.StatusCode,
			http.StatusMethodNotAllowed,
		)
	}

	if got := result.Header.Get("Allow"); got != http.MethodGet {
		t.Errorf(
			"Allow = %q, want %q",
			got,
			http.MethodGet,
		)
	}
}

func TestWidgetContentEndpointUnknownWidget(t *testing.T) {
	app, _ := newNativeRefreshTestApplication()

	request := httptest.NewRequest(
		http.MethodGet,
		"/api/widgets/999/content/",
		nil,
	)
	request.SetPathValue("widget", "999")
	request.SetPathValue("path", "content/")

	response := httptest.NewRecorder()

	app.handleWidgetRequest(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf(
			"status = %d, want %d",
			response.Code,
			http.StatusNotFound,
		)
	}
}
