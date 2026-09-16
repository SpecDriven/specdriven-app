namespace acme.claims;

using { cuid, managed } from '@sap/cds/common';

entity Customers : cuid, managed {
  firstName : String(100);
  lastName  : String(100);
  email     : String;
  phone     : String;
  claims    : Association to many Claims on claims.customer = $self;
}

entity Claims : cuid, managed {
  claimNumber : String(20);
  @title: 'Amount claimed'
  amount      : Decimal(12, 2);
  status      : String enum { open; approved; denied; paid; };
  incidentOn  : Date;
  customer    : Association to Customers;
}
