# Code Review Checklist

## Correctness
- [ ] Logic handles all cases correctly
- [ ] Edge cases are handled
- [ ] Error handling is appropriate
- [ ] No off-by-one errors
- [ ] Null/undefined checks where needed

## Security
- [ ] Input is validated/sanitized
- [ ] No hardcoded secrets or credentials
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS prevention (output encoding)
- [ ] CSRF protection where applicable
- [ ] Sensitive data is encrypted

## Performance
- [ ] No unnecessary loops/iterations
- [ ] Appropriate data structures used
- [ ] No memory leaks
- [ ] Database queries are optimized
- [ ] Caching considered where appropriate
- [ ] No N+1 query problems

## Maintainability
- [ ] Clear naming conventions
- [ ] Functions are single-purpose
- [ ] No magic numbers (use constants)
- [ ] Adequate comments for complex logic
- [ ] DRY principle followed
- [ ] SOLID principles applied where relevant

## Testing
- [ ] Unit tests exist for new functionality
- [ ] Edge cases are tested
- [ ] Error paths are tested
- [ ] Tests are readable and maintainable
- [ ] Test coverage is adequate

## Documentation
- [ ] Public APIs are documented
- [ ] Complex algorithms are explained
- [ ] README updated if needed
- [ ] Breaking changes documented
