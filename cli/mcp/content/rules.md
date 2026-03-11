## Deletion Rules

### In-App Purchases
- **In-app purchases cannot be deleted once created.**
### Subscriptions
- **Subscriptions cannot be deleted once created.**

### Subscription Groups
- **Subscription groups cannot be deleted once created.**

## Immutable Properties

### IAP Type
- **The type of an in-app purchase cannot be changed after creation.**

### Subscription Period
- **The subscription period cannot be changed once a subscription is created.**

### Family Sharing
- **Family sharing cannot be turned off once enabled** for both IAPs and subscriptions.

## Ordering and Dependencies

### Pricing Requires Availability
- **Availability must be set up before or at the same time as pricing** for IAPs and subscriptions.

## Price Schedules

### Base Territory
- **The base territory must have a corresponding price in the prices array.**
- If `baseTerritory` is `"USA"`, there must be a price entry with `territory: "USA"`.

### Pricing
- **Base territory pricing applies to all territories by default.**
- Territories specified in the pricing array use their specified prices instead of the base territory price.
- To set pricing for all territories, it is enough to provide only a base territory and its price.

## Product ID Requirements

### Uniqueness
- **Product IDs must be unique across all in-app purchases and subscriptions.**
- To ensure global uniqueness, it's common practice to prepend the bundle ID to the product ID (e.g., `com.example.app.premium`).

## String Field Requirements

### Character Restrictions
- **Emojis are not allowed in string/text fields.**
- Simple punctuation is allowed: `" ? : ; ! - • @ & $ ' ( ) — – - [ ] =`

## Localization Guidelines

### Missing Fields
- **Missing fields for additional root 'localizations' field will be filled with the values from the primary locale.**
- Skip fields instead of repeating to use the same values from the primary locale.

### Content Guidelines (Unless Asked Otherwise)
- **Make app descriptions long and beautiful, talk about the benefits. Use line breaks, uppercase, available punctuations to make it more readable.**
- **Separate keywords field values with a single comma and no space. Do not repeat title and subtitle words in the keywords within the same localization. Do not use plurals. (i.e. "foo,bar,baz")**