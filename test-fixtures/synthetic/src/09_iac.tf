// Exercises: Terraform IaC resource graph edge.
// `aws_lambda_function.processor` references `aws_dynamodb_table.events.name`
// — the Terraform adapter must lift this attribute reference into a resource
// dependency edge.

resource "aws_dynamodb_table" "events" {
  name         = "events"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }
}

resource "aws_lambda_function" "processor" {
  function_name = "processor"
  role          = "arn:aws:iam::000000000000:role/lambda-exec"
  handler       = "index.handler"
  runtime       = "nodejs20.x"

  environment {
    variables = {
      EVENTS_TABLE = aws_dynamodb_table.events.name
    }
  }
}
