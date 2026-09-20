// A clipper profile that passes every required-details check. Spread into a
// clippers seed row for any test that goes through a route which needs one
// (joining, submitting a video, asking to connect an account).
export const COMPLETE_PROFILE = {
  email: 'test@example.com',
  contact_number: '9876543210',
  upi_id: 'testuser@okbank',
  upi_account_name: 'Test Person',
  legal_name: 'Test Person',
  discord_username: 'testuser'
};
