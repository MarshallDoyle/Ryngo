// Exercises: Chi router with nested r.Route + middleware + handler.
//
// The adapter must produce:
//   - http-route edges for "/api/health" (GET) and "/api/widgets/{id}" (GET)
//     where each handler is the source and the path literal is the target leaf.
//   - call edge from each handler to the chained middleware (logger).

package synthetic

import (
	"net/http"

	"github.com/go-chi/chi/v5"
)

func logger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r)
	})
}

func health(w http.ResponseWriter, _ *http.Request) {
	_, _ = w.Write([]byte("ok"))
}

func getWidget(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	_, _ = w.Write([]byte(id))
}

func NewRouter() *chi.Mux {
	r := chi.NewRouter()
	r.Use(logger)
	r.Route("/api", func(r chi.Router) {
		r.Get("/health", health)
		r.Get("/widgets/{id}", getWidget)
	})
	return r
}
