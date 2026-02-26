# Common Design Patterns

## Creational Patterns

### Factory
Create objects without specifying exact class.
```javascript
function createUser(type) {
  switch(type) {
    case 'admin': return new AdminUser();
    case 'guest': return new GuestUser();
    default: return new User();
  }
}
```

### Builder
Construct complex objects step by step.
```javascript
const user = new UserBuilder()
  .setName('John')
  .setEmail('john@example.com')
  .setRole('admin')
  .build();
```

### Singleton
Ensure single instance throughout application.
```javascript
class Database {
  static instance;
  static getInstance() {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }
}
```

## Structural Patterns

### Adapter
Convert interface to another expected interface.
```javascript
class OldAPI { request() { /* old format */ } }
class NewAPIAdapter {
  constructor(oldApi) { this.oldApi = oldApi; }
  fetch() { return this.oldApi.request(); }
}
```

### Decorator
Add behavior dynamically without inheritance.
```javascript
function withLogging(fn) {
  return function(...args) {
    console.log('Called with:', args);
    return fn.apply(this, args);
  };
}
```

### Facade
Simplified interface to complex system.
```javascript
class OrderFacade {
  placeOrder(items, user) {
    inventory.check(items);
    payment.process(user);
    shipping.schedule(items, user);
  }
}
```

## Behavioral Patterns

### Observer
Notify dependents of state changes.
```javascript
class EventEmitter {
  listeners = {};
  on(event, callback) { /* subscribe */ }
  emit(event, data) { /* notify all */ }
}
```

### Strategy
Interchangeable algorithms.
```javascript
const strategies = {
  bubble: arr => { /* bubble sort */ },
  quick: arr => { /* quick sort */ },
  merge: arr => { /* merge sort */ }
};
function sort(arr, strategy) {
  return strategies[strategy](arr);
}
```

### Command
Encapsulate requests as objects.
```javascript
class Command {
  execute() {}
  undo() {}
}
class AddItemCommand extends Command {
  execute() { cart.add(this.item); }
  undo() { cart.remove(this.item); }
}
```

## Modern JavaScript Patterns

### Module Pattern
```javascript
const Counter = (() => {
  let count = 0;
  return {
    increment: () => ++count,
    get: () => count
  };
})();
```

### Pub/Sub
```javascript
const pubsub = {
  events: {},
  subscribe(event, fn) { /* add listener */ },
  publish(event, data) { /* notify all */ }
};
```

### Middleware
```javascript
const middlewares = [];
function use(fn) { middlewares.push(fn); }
async function execute(ctx) {
  for (const fn of middlewares) await fn(ctx);
}
```
