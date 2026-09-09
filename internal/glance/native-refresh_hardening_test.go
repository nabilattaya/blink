package glance

import (
	"context"
	"fmt"
	"html/template"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
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
	testWidget := &nativeRefreshContextWidget{}
	testWidget.Type = "test"
	testWidget.ID = 42
	testWidget.cacheType = cacheTypeDuration
	testWidget.cacheDuration = time.Hour

	testPage := &page{}
	app := &application{
		widgetByID:     map[uint64]widget{42: testWidget},
		pageByWidgetID: map[uint64]*page{42: testPage},
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

	if testWidget.contextErr != context.Canceled {
		t.Fatalf("widget update context error = %v, want context.Canceled", testWidget.contextErr)
	}
}

func (widget *nativeRefreshCountingWidget) handleRequest(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusTeapot)
}

func TestNativeRefreshAndGenericWidgetRoutes(t *testing.T) {
	requested := &nativeRefreshCountingWidget{}
	requested.ID = 42
	requested.cacheType = cacheTypeDuration
	requested.cacheDuration = time.Hour
	app := &application{
		widgetByID:     map[uint64]widget{42: requested},
		pageByWidgetID: map[uint64]*page{42: {}},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/widgets/{widget}/content/{$}", app.handleNativeWidgetContentRequest)
	mux.HandleFunc("/api/widgets/{widget}/{path...}", app.handleWidgetRequest)

	for _, path := range []string{"content/", "arbitrary/path", "content/subpath"} {
		response := httptest.NewRecorder()
		mux.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/widgets/42/"+path, nil))
		want := http.StatusNotImplemented
		if path == "content/" {
			want = http.StatusOK
			if !strings.Contains(response.Body.String(), `data-widget-id="42"`) {
				t.Fatalf("native refresh did not render the requested widget: %s", response.Body)
			}
		}
		if response.Code != want {
			t.Fatalf("%s status = %d, want %d", path, response.Code, want)
		}
	}
	if requested.updateCount != 1 {
		t.Fatalf("update count = %d, want 1", requested.updateCount)
	}
}

func TestNativeRefreshAuthorizationPrecedesMethodAndLookup(t *testing.T) {
	app, _ := newNativeRefreshTestApplication()
	app.RequiresAuth = true
	for _, method := range []string{http.MethodGet, http.MethodPost} {
		for _, id := range []string{"42", "999", "invalid"} {
			request := httptest.NewRequest(method, "/api/widgets/"+id+"/content/", nil)
			request.SetPathValue("widget", id)
			response := httptest.NewRecorder()
			app.handleNativeWidgetContentRequest(response, request)
			if response.Code != http.StatusUnauthorized {
				t.Fatalf("%s %s status = %d, want 401", method, id, response.Code)
			}
		}
	}
}

func TestNativeRefreshHonorsCache(t *testing.T) {
	requested := &nativeRefreshCountingWidget{}
	requested.ID = 42
	requested.cacheType = cacheTypeDuration
	requested.cacheDuration = time.Hour
	app := &application{
		widgetByID:     map[uint64]widget{42: requested},
		pageByWidgetID: map[uint64]*page{42: {}},
	}
	for i := 0; i < 3; i++ {
		if i == 2 {
			requested.nextUpdate = time.Now().Add(-time.Second)
		}
		request := httptest.NewRequest(http.MethodGet, "/api/widgets/42/content/", nil)
		request.SetPathValue("widget", "42")
		response := httptest.NewRecorder()
		app.handleNativeWidgetContentRequest(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", response.Code)
		}
		wantUpdates := 1
		if i == 2 {
			wantUpdates = 2
		}
		if requested.updateCount != wantUpdates {
			t.Fatalf("request %d: updates = %d, want %d", i, requested.updateCount, wantUpdates)
		}
	}
}

func TestNativeRefreshRegistersNestedChildren(t *testing.T) {
	config, err := newConfigFromYAML([]byte(`
pages:
  - name: Nested
    columns:
      - size: full
        widgets:
          - type: split-column
            widgets:
              - type: group
                widgets:
                  - type: clock
                    refresh: 1s
                  - type: calendar
              - type: clock
                refresh: 2s
`))
	if err != nil {
		t.Fatal(err)
	}
	app, err := newApplication(config)
	if err != nil {
		t.Fatal(err)
	}
	if len(app.widgetByID) != 5 {
		t.Fatalf("registered %d widgets, want 5", len(app.widgetByID))
	}
	for id, widget := range app.widgetByID {
		if app.pageByWidgetID[id] != &app.Config.Pages[0] {
			t.Fatalf("widget %d has incorrect page", id)
		}
		if widget.GetType() != "clock" {
			continue
		}
		request := httptest.NewRequest(http.MethodGet, "/api/widgets/"+strconv.FormatUint(id, 10)+"/content/", nil)
		request.SetPathValue("widget", strconv.FormatUint(id, 10))
		response := httptest.NewRecorder()
		app.handleNativeWidgetContentRequest(response, request)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "data-widget-refresh=") {
			t.Fatalf("nested clock response = %d: %s", response.Code, response.Body)
		}
	}
}

func TestNativeRefreshWidgetIDsAcrossProcesses(t *testing.T) {
	if os.Getenv("BLINK_TEST_WIDGET_PROCESS") == "1" {
		first, err := newWidget("clock")
		if err != nil {
			t.Fatal(err)
		}
		second, err := newWidget("calendar")
		if err != nil {
			t.Fatal(err)
		}
		if second.GetID() != first.GetID()+1 {
			t.Fatal("widget IDs no longer increment atomically")
		}
		fmt.Print(first.GetID())
		os.Exit(0)
	}

	var ids []uint64
	for i := 0; i < 2; i++ {
		command := exec.Command(os.Args[0], "-test.run=^TestNativeRefreshWidgetIDsAcrossProcesses$")
		command.Env = append(os.Environ(), "BLINK_TEST_WIDGET_PROCESS=1")
		output, err := command.Output()
		if err != nil {
			t.Fatal(err)
		}
		id, err := strconv.ParseUint(string(output), 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if ids[0] == ids[1] || ids[0] == ids[1]+1 || ids[0]+1 == ids[1] {
		t.Fatalf("separate processes reused widget IDs: %v", ids)
	}

	// The old clock ID must not resolve to a calendar first in a restarted process.
	app, _ := newNativeRefreshTestApplication()
	app.widgetByID = map[uint64]widget{ids[1]: &calendarWidget{}}
	request := httptest.NewRequest(http.MethodGet, "/api/widgets/old/content/", nil)
	request.SetPathValue("widget", strconv.FormatUint(ids[0], 10))
	response := httptest.NewRecorder()
	app.handleNativeWidgetContentRequest(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("stale widget status = %d, want 404", response.Code)
	}
}
