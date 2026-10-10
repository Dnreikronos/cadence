use crate::{
    audit::store::{AuditStore, Grant, Page, Payment},
    auth::SupabaseAuth,
    error::AppError,
};
use axum::{
    extract::{rejection::JsonRejection, DefaultBodyLimit, Path, Query, State},
    http::{header::CACHE_CONTROL, HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::Semaphore;

pub struct Service {
    auth: SupabaseAuth,
    store: AuditStore,
    slots: Arc<Semaphore>,
}

impl Service {
    /// Combine verified bearer authentication with the dedicated audit database role.
    /// At most four company pages may decrypt concurrently through this service.
    pub fn new(auth: SupabaseAuth, database_url: &str) -> Result<Self, AppError> {
        Ok(Self {
            auth,
            store: AuditStore::new(database_url)?,
            slots: Arc::new(Semaphore::new(4)),
        })
    }

    /// Load audit configuration, leaving the service disabled when its URL is absent.
    pub fn from_env() -> Result<Option<Self>, AppError> {
        Self::parse(|name| std::env::var(name).ok())
    }

    /// Require Supabase Auth settings whenever the audit database URL is supplied.
    /// An absent audit URL returns `None`; incomplete enabled configuration is an error.
    pub fn parse(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, AppError> {
        let Some(database) = get("PROOF_AUDIT_DATABASE_URL") else {
            return Ok(None);
        };
        let origin = get("PROOF_SUPABASE_URL")
            .and_then(|value| value.parse().ok())
            .ok_or(AppError::Config("audit requires PROOF_SUPABASE_URL"))?;
        let api_key = get("PROOF_SUPABASE_API_KEY")
            .ok_or(AppError::Config("audit requires PROOF_SUPABASE_API_KEY"))?;
        Self::new(SupabaseAuth::new(origin, &api_key)?, &database).map(Some)
    }
}

/// Register bounded audit and grant routes, including fixed 503s when disabled.
/// The middleware marks every response as uncacheable, including rejections.
pub fn router(service: Option<Arc<Service>>) -> Router {
    Router::new()
        .route("/audit/{company}/payments", get(payments))
        .route("/company/auditor-grants", get(grants).post(create_grant))
        .route("/company/auditor-grants/{id}/revoke", post(revoke_grant))
        .layer(DefaultBodyLimit::max(8192))
        .layer(middleware::from_fn(no_store))
        .with_state(service)
}

/// Keep successful amount reads and all error responses out of HTTP caches.
async fn no_store(request: axum::extract::Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/// Normalize a non-nil UUID without echoing invalid input in the response.
fn uuid(value: &str) -> Result<String, AppError> {
    uuid::Uuid::parse_str(value)
        .ok()
        .filter(|id| !id.is_nil())
        .map(|id| id.to_string())
        .ok_or(AppError::BadRequest("invalid_request"))
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pagination {
    limit: Option<String>,
    cursor: Option<String>,
}
impl Pagination {
    /// Default to 20 rows and reject limits outside 1 to 100 or invalid cursors.
    fn validate(self) -> Result<(i32, Option<String>), AppError> {
        let limit = self
            .limit
            .as_deref()
            .unwrap_or("20")
            .parse::<i32>()
            .ok()
            .filter(|limit| (1..=100).contains(limit))
            .ok_or(AppError::BadRequest("invalid_request"))?;
        let cursor = self.cursor.as_deref().map(uuid).transpose()?;
        Ok((limit, cursor))
    }
}

/// Authenticate before validating scope, then bound concurrent page decryption.
async fn payments(
    State(service): State<Option<Arc<Service>>>,
    headers: HeaderMap,
    Path(company): Path<String>,
    query: Result<Query<Pagination>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Page<Payment>>, AppError> {
    let service = service.ok_or(AppError::AuditUnavailable)?;
    let user = service.auth.user(&headers).await?;
    let company = uuid(&company)?;
    let (limit, cursor) = query
        .map_err(|_| AppError::BadRequest("invalid_request"))?
        .0
        .validate()?;
    let _permit = service
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| AppError::AuditUnavailable)?;
    Ok(Json(
        service
            .store
            .payments(&user, &company, limit, cursor.as_deref())
            .await?,
    ))
}

/// Return grant metadata for the verified admin's company without decrypting.
async fn grants(
    State(service): State<Option<Arc<Service>>>,
    headers: HeaderMap,
    query: Result<Query<Pagination>, axum::extract::rejection::QueryRejection>,
) -> Result<Json<Page<Grant>>, AppError> {
    let service = service.ok_or(AppError::AuditUnavailable)?;
    let user = service.auth.user(&headers).await?;
    let (limit, cursor) = query
        .map_err(|_| AppError::BadRequest("invalid_request"))?
        .0
        .validate()?;
    Ok(Json(
        service
            .store
            .grants(&user, limit, cursor.as_deref())
            .await?,
    ))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct GrantRequest {
    auditor_id: String,
}

/// Validate the auditor identity and let membership and RLS choose the company.
async fn create_grant(
    State(service): State<Option<Arc<Service>>>,
    headers: HeaderMap,
    body: Result<Json<GrantRequest>, JsonRejection>,
) -> Result<(StatusCode, Json<Grant>), AppError> {
    let service = service.ok_or(AppError::AuditUnavailable)?;
    let user = service.auth.user(&headers).await?;
    let auditor = uuid(
        &body
            .map_err(|_| AppError::BadRequest("invalid_request"))?
            .0
            .auditor_id,
    )?;
    Ok((
        StatusCode::CREATED,
        Json(service.store.create_grant(&user, &auditor).await?),
    ))
}

/// Revoke only a grant belonging to the verified admin's company.
async fn revoke_grant(
    State(service): State<Option<Arc<Service>>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>, AppError> {
    let service = service.ok_or(AppError::AuditUnavailable)?;
    let user = service.auth.user(&headers).await?;
    service.store.revoke_grant(&user, &uuid(&id)?).await?;
    Ok(Json(json!({"status": "revoked"})))
}
